import { buildFsToolDefs, executeFsTool } from "./fsTools.js";
import { routeCloudWithRetry } from "./router.js";
import { parseStructured } from "./outputSchema.js";
import { leakedToolCallDialect, looksLikeLeakedToolCall, parseLeakedToolCalls } from "../helpers/toolCallLeak.js";
import { NanitesError } from "../helpers/errors.js";
import { PROVIDER_ERROR_CODES } from "./errors.js";
/**
 * Round cap, sized to the task. A fixed cap was
 * measured wrong: the audit brief names eight files, the model reads one file
 * per round, and a cap of six cut it off mid-read and then asked it to answer —
 * which is where the empty answer round comes from. The cap is therefore
 * planned from the brief and extended while the model is still discovering
 * files.
 *
 * Cost: each round is a full provider call and `chatWithBudgetRetry` may spend
 * two attempts on it, so the worst case is `(CEILING + 1) * 2` requests.
 * `TOOL_ROUND_FLOOR` is the old fixed value and applies whenever the brief
 * names no files, so a caller that gave the loop no signal sees no change.
 */
export const TOOL_ROUND_FLOOR = 6;
export const TOOL_ROUND_CEILING = 10;
const TOOL_OUTPUT_TRUNCATE = 4_000;
/** Extensions that make a dotted token count as "a file this task is about". */
const NAMED_FILE_EXTENSIONS = new Set([
    "ts", "tsx", "js", "mjs", "cjs", "jsx", "json", "md", "markdown",
    "py", "go", "rs", "java", "kt", "rb", "php", "c", "cc", "cpp", "h", "hpp",
    "cs", "sh", "bash", "ps1", "sql", "yml", "yaml", "toml", "ini",
    "css", "scss", "html", "vue", "svelte", "txt",
]);
/** Slack for the directory listings and re-reads a real run spends on top of
 * one round per named file — the live audit run spent two rounds listing before
 * it read anything. */
const NAMED_FILE_SLACK = 3;
const NAMED_FILE_RE = /[\w@./\\-]+\.([A-Za-z0-9]{1,6})\b/g;
/**
 * Distinct files the brief names that look like source or documentation. This
 * is the only content-aware complexity signal available at the loop's boundary
 * (see runSubAgent.ts, which passes profile/brief/role only), and it is the one
 * that matched the defect: the audit brief named eight files and the loop read
 * six.
 */
export function namedFileCount(brief) {
    const named = new Set();
    for (const match of brief.matchAll(NAMED_FILE_RE)) {
        if (NAMED_FILE_EXTENSIONS.has(match[1].toLowerCase()))
            named.add(match[0].toLowerCase());
    }
    return named.size;
}
/**
 * The cap a run starts with: one round per named file, plus slack, clamped to
 * floor and ceiling. Exported so the sizing is testable without a live run.
 */
export function plannedToolRounds(brief) {
    return Math.min(TOOL_ROUND_CEILING, Math.max(TOOL_ROUND_FLOOR, namedFileCount(brief) + NAMED_FILE_SLACK));
}
/**
 * Identity of a tool call, for progress detection: re-asking for the same file
 * is not progress, so it must not buy another round. Arguments are key-sorted
 * because the model is free to write them in any order.
 */
export function stableToolKey(name, args) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return `${name}:${JSON.stringify(args ?? null)}`;
    }
    const entries = Object.entries(args).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `${name}:${JSON.stringify(entries)}`;
}
/**
 * Opens the finalize round. Without a fresh user turn the
 * transcript ends on a tool result, and the model has no reason to answer
 * again; stating the contract flatly is what makes the round one call instead
 * of a negotiation.
 */
const FINALIZE_INSTRUCTION = "Return your final answer now as a single JSON value matching the requested schema. " +
    "No prose, no code fences, no commentary.";
/**
 * Effort used on rounds that advertise tools. Routing a call to the right tool
 * with the right arguments is cheap thinking; the expensive reasoning belongs
 * on the final answer. Cost is governed by `reasoning_effort`, not by the
 * token ceiling, so lowering it here is the lever that actually saves tokens.
 * A tool-less run never takes this path and always uses the requested effort.
 */
const TOOL_ROUND_EFFORT = "low";
/**
 * Effort for the finalize round. Not the requested effort: that one is sized
 * for a report plus its thinking tokens, and the finalize round does neither —
 * it reformats an answer that already exists. Measured on a real run:
 * the answer round burned its full 12288-token budget in 205 s, and the finalize
 * round then ran at the loop's medium effort (reasoning ON for `reviewer`) and
 * crossed the 240 s client timeout, discarding a completed run.
 */
const FINALIZE_EFFORT = "low";
/**
 * Output ceiling for the finalize round, in tokens. A schema-shaped answer is
 * small — the toolkit caps a caller's schema at 8000 chars — so the effort
 * fraction's 12288-16384 is the wrong shape here. 4096 leaves room for a
 * generous report and bounds the worst case to ~1/3 of the answer round's.
 */
const FINALIZE_OUTPUT_TOKENS = 4096;
/**
 * Nudges the model out of the loop once it has what it needs. Every round
 * re-sends the whole transcript, so extra rounds are expensive — which is why
 * a batching instruction was tried here and dropped: models that can finish
 * the review batch unprompted, and the model that walked the files one per
 * round ignored the instruction in two separate wordings.
 */
const TOOL_LOOP_INSTRUCTION = "After you have read all necessary files, produce your final report. " +
    "Do not call tools again once you have enough information.";
/**
 * The empty-answer rescue. The answer round's transcript ends on a `role:"tool"`
 * message; on `@cf/openai/gpt-oss-120b` the model then emits a few dozen
 * characters of reasoning and stops (`finish_reason: stop`, empty content).
 * Two things were measured about that: the budget is not the lever (identical
 * reasoning length at 16384 and 32768), and neither is the wording — the same
 * instruction folded into the **system prompt**, with the transcript left
 * ending on `tool`, returned 0 content in 6 of 6 attempts.
 *
 * What the model does respond to is a turn it can answer from, so this text
 * rides inside a rebuilt transcript (`buildRescueDocument`) — one `user`
 * message, no tool results, no tool schemas — rather than being appended to a
 * transcript the model was midway through reading.
 */
const RESCUE_INSTRUCTION = "Using the tool results above, answer the original request now in plain prose. " +
    "Do not request more tools and do not describe what you would read. " +
    "If some requested files were not read, say so plainly and report on what you have.";
/**
 * Effort for the rescue round — the same setting, and the same reasoning, as
 * `FINALIZE_EFFORT`: the rescue is a reformatting of work already done, not
 * another round of thinking about it.
 */
const RESCUE_EFFORT = "low";
/**
 * Size caps for the rescue document. The loop's own `messages` carry the FULL
 * tool output (`read_file` returns up to 24000 chars — fsTools.ts), so ten
 * reads would otherwise rebuild a 240 KB prompt. The per-entry cap bounds one
 * oversized file; the total cap bounds the whole document.
 */
const RESCUE_ENTRY_CHARS = 4_000;
const RESCUE_DOC_CHARS = 40_000;
/** Cut a string to `max` chars, saying so when it had to. */
function clip(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}\n[truncated: ${text.length - max} chars]`;
}
/**
 * Rebuilds the run's tool work as ONE `user` message. The model is handed a
 * document to answer from rather than a tool transcript to continue, which is
 * the difference the live measurements point at: every turn that still had
 * tools offered came back as another tool call, and the only silent turn was
 * the one that withdrew them.
 *
 * On overflow the MIDDLE is dropped: the first results are the directory
 * orientation the later reads depend on, and the last is the file that tipped
 * the run into answering. Exported so the capping rule is directly testable.
 */
export function buildRescueDocument(brief, transcript, instruction = RESCUE_INSTRUCTION) {
    const head = [
        "You have already gathered the tool results below and cannot read any more files.",
        "",
        "## The original request",
        "",
        brief,
        "",
        "## Tool results",
        "",
    ];
    const entries = transcript.map((entry, i) => [
        `### ${i + 1}. ${entry.tool} ${JSON.stringify(entry.args ?? {})}`,
        "",
        clip(entry.output, RESCUE_ENTRY_CHARS),
        "",
    ].join("\n"));
    const tail = ["", instruction];
    const fixedChars = head.join("\n").length + tail.join("\n").length;
    const budget = RESCUE_DOC_CHARS - fixedChars;
    // Fit entries head-and-tail first, then report whatever did not make it.
    const keep = new Set();
    let used = 0;
    for (let i = 0; i < entries.length; i++) {
        const next = entries[i].length;
        const isLast = i === entries.length - 1;
        if (used + next <= budget) {
            keep.add(i);
            used += next;
        }
        else if (isLast) {
            // The newest result is the one that tipped the run into answering; it
            // earns its place even over budget, and guarantees a non-empty document.
            keep.add(i);
            used += next;
        }
    }
    const omitted = entries.length - keep.size;
    const firstOmitted = entries.findIndex((_, i) => !keep.has(i));
    const body = entries
        .map((entry, i) => {
        if (keep.has(i))
            return entry;
        return i === firstOmitted
            ? `[... ${omitted} tool result(s) omitted to cap this document at ${RESCUE_DOC_CHARS} chars ...]\n`
            : "";
    })
        .join("");
    return [{ role: "user", content: [...head, body, ...tail].join("\n") }];
}
/**
 * A reply that is a pathological blob, not prose or a tool call. A
 * runaway token-loop reply (e.g. one giant whitespace-free string, or an
 * answer whose content collapses to a couple of tokens) is junk that would
 * otherwise be accepted as "the answer" because `content` is non-empty and
 * `finish_reason` is `stop`. The loop treats it like an empty reply and falls
 * back to the document rescue.
 */
export function looksLikeRunawayReply(text) {
    if (!text || text.length < 200)
        return false;
    const ws = text.replace(/\S/g, "").length;
    if (ws / text.length < 0.01)
        return true;
    const tokens = text.split(/\s+/).filter(Boolean);
    return tokens.length <= 2 && text.length > 400;
}
/** True when the round produced calls to execute (not merely text). */
function roundHasCalls(resp) {
    return Array.isArray(resp.tool_calls) && resp.tool_calls.length > 0;
}
export async function runCloudToolLoop(opts) {
    const { profile, db, provider, modelId, effort, role, brief, systemPrompt, fsGrant, onEvent } = opts;
    const { outputSchema, outputSchemaName } = opts;
    const route = opts.route ?? routeCloudWithRetry;
    const toolDefs = fsGrant ? buildFsToolDefs(fsGrant) : [];
    const messages = [{ role: "user", content: brief }];
    const rounds = [];
    const toolsUsed = [];
    // The instruction only means anything when tools are on the table.
    const baseSystemPrompt = systemPrompt;
    const loopSystemPrompt = toolDefs.length > 0 && systemPrompt
        ? `${systemPrompt}\n\n${TOOL_LOOP_INSTRUCTION}`
        : toolDefs.length > 0
            ? TOOL_LOOP_INSTRUCTION
            : systemPrompt;
    const roundOpts = (advertiseTools, responseFormat) => ({
        profile,
        db,
        // Cheap thinking while routing tools, full effort for the answer round.
        effort: advertiseTools ? TOOL_ROUND_EFFORT : effort,
        role,
        brief,
        messages,
        systemPrompt: loopSystemPrompt,
        ...(advertiseTools ? { tools: toolDefs } : {}),
        ...(responseFormat ? { responseFormat } : {}),
    });
    let finalContent = "";
    let truncated;
    let answered = false;
    /** The forced tool-less answer round produced nothing. */
    let answerRoundFailed = false;
    /** The structured error that answer round raised, kept so the rescue can pin
     * its model and the failure path can report what actually happened. */
    let pendingBudgetError = null;
    let rescueAttempted = false;
    /** A round whose content was a leaked tool call we could not execute. Also
     * arms the F6 rescue when the run had already read something. */
    let leakedToolCall = false;
    /** A round answered with a runaway token-loop blob (no prose, no
     * tool call). Arms the rescue like an empty answer round. */
    let junkReply = false;
    /** Non-fatal notes for the caller's `validation.issues`. */
    const loopIssues = [];
    const advertisedNames = new Set(toolDefs.map((d) => d.function.name));
    /**
     * The run's tool work in full (unlike `toolsUsed`, which truncates each
     * output and drops the arguments), so the rescue can rebuild it as a document
     * that says which file each result came from. Never returned to the caller.
     */
    const toolTranscript = [];
    /** Calls already executed — a repeat is not progress. */
    const executedKeys = new Set();
    /** The planned cap, extended on progress (never above `TOOL_ROUND_CEILING`). */
    const plannedCap = plannedToolRounds(brief);
    let cap = plannedCap;
    let extensions = 0;
    /**
     * Executes one round's calls and reports whether they were all new work.
     * A round that only re-reads what it already read has made no progress and
     * must not buy another round off the ceiling.
     */
    const runCalls = async (calls) => {
        const fresh = calls.length > 0 && calls.every((c) => !executedKeys.has(stableToolKey(c.name, c.arguments)));
        for (const call of calls) {
            onEvent?.("chat.tool", { tool: call.name });
            const { output } = await executeFsTool(fsGrant, call.name, call.arguments);
            toolsUsed.push({ tool: call.name, output: output.slice(0, TOOL_OUTPUT_TRUNCATE) });
            toolTranscript.push({ tool: call.name, args: call.arguments, output });
            executedKeys.add(stableToolKey(call.name, call.arguments));
            messages.push({ role: "tool", content: output, tool_call_id: call.id, name: call.name });
        }
        return fresh;
    };
    /**
     * Buys one extra round when the model is still finding new files. The first
     * round never counts: it cannot be evidence of running past the plan, and the
     * plan already budgets slack for the orientation pass a real run starts with.
     * Without that exception every loop — including the fence runs whose briefs
     * name nothing — would clear its cap on the first tool call.
     */
    const extendOnProgress = (round, fresh) => {
        if (round === 0 || !fresh || cap >= TOOL_ROUND_CEILING)
            return;
        cap += 1;
        extensions += 1;
    };
    for (let round = 0; round <= cap; round++) {
        // The last permitted round advertises no tools. A model with enough context
        // then answers instead of asking for another file, which is what a capped
        // loop would otherwise punish with an empty reply.
        const advertiseTools = toolDefs.length > 0 && round < cap;
        onEvent?.("chat.round", { round, tools_advertised: advertiseTools });
        let result;
        try {
            // The final round presents the gathered tool results as one
            // rebuilt document (the shape measured to answer) instead of replaying
            // the tool-terminal transcript (the shape measured to empty on
            // gpt-oss-120b). Same shape, effort and system prompt as the rescue, so
            // a run that was going to pay for a doomed answer round + a rescue now
            // pays for one document round that answers.
            const finalDoc = !advertiseTools && toolDefs.length > 0 && toolTranscript.length > 0;
            const roundRoute = finalDoc
                ? {
                    ...roundOpts(false),
                    effort: RESCUE_EFFORT,
                    messages: buildRescueDocument(brief, toolTranscript),
                    systemPrompt: baseSystemPrompt,
                }
                : roundOpts(advertiseTools);
            result = await route(roundRoute, provider, modelId);
        }
        catch (err) {
            // The answer round is the only round that runs at the
            // requested effort AND the only one with no tools on the wire, so it is
            // the one that dies this way; a failure anywhere else is a different
            // defect and must keep propagating untouched. Held rather than thrown so
            // the rescue below can try once, and so a failed rescue still reports a
            // run that read six files instead of a bare provider error.
            if (err instanceof NanitesError &&
                err.code === PROVIDER_ERROR_CODES.BUDGET_EXHAUSTED &&
                round >= cap &&
                toolsUsed.length > 0) {
                pendingBudgetError = err;
                answerRoundFailed = true;
                break;
            }
            throw err;
        }
        const resp = result.response;
        // Native tool_calls are filtered by the advertised set, exactly as the
        // leaked-markup path below already was. Only executeFsTool's own guard
        // stood between a provider-supplied name and execution, and that guard
        // used to fail open, so a provider could echo a tool name
        // the model was never offered.
        const calls = (resp.tool_calls ?? []).filter((c) => advertisedNames.has(c.name));
        const text = resp.content ?? "";
        // Some cloud models write the call into `content` in their own
        // chat-template dialect and report finish_reason=stop, so there is no
        // `tool_calls` for the loop to execute and the old accept-anything branch
        // below returned the markup as the final reply — a `done` job that
        // delegated nothing. Parse the leak and run it like a real tool round; if
        // it cannot be read (or there is nothing to run it with) fail loudly
        // instead of answering with it.
        if (calls.length === 0 && looksLikeLeakedToolCall(text)) {
            const parsed = parseLeakedToolCalls(text);
            const runnable = (parsed ?? []).filter((c) => advertisedNames.has(c.name));
            rounds.push({ result, calls: runnable, toolsAdvertised: advertiseTools });
            if (runnable.length === 0 || !fsGrant || round >= cap) {
                leakedToolCall = true;
                loopIssues.push("tool_call_leak_detected");
                onEvent?.("chat.tool_leak", {
                    dialect: leakedToolCallDialect(text),
                    parsed: parsed !== null,
                    executed: false,
                });
                break;
            }
            loopIssues.push("tool_call_leak_parsed");
            onEvent?.("chat.tool_leak", {
                dialect: leakedToolCallDialect(text),
                parsed: true,
                executed: true,
                tools: runnable.map((c) => c.name),
            });
            messages.push({ role: "assistant", content: text, tool_calls: runnable });
            extendOnProgress(round, await runCalls(runnable));
            continue;
        }
        // Text the model emitted on this round (commentary or the final answer).
        // Only non-empty, non-runaway text is kept, so a later tool-only round
        // cannot erase an answer the model already gave.
        if (text && !looksLikeRunawayReply(text)) {
            finalContent = text;
            answered = true;
        }
        if (calls.length === 0) {
            // A tool-less answer round that came back with nothing is the same defect
            // as the thrown one above, arrived at without a provider error. A runaway
            // blob that passed as text is the same class: refuse it,
            // don't answer with it.
            const runaway = looksLikeRunawayReply(text);
            if (round >= cap && (!text.trim() || runaway)) {
                answerRoundFailed = true;
                if (runaway) {
                    junkReply = true;
                    loopIssues.push("reply_rejected_runaway");
                }
            }
            rounds.push({ result, calls, toolsAdvertised: advertiseTools });
            break;
        }
        // No grant = no tools advertised. If a provider echoes tool_calls anyway,
        // never execute them against the process cwd — stop instead.
        if (!fsGrant) {
            truncated = "model returned tool_calls but no fs grant is configured";
            rounds.push({ result, calls, toolsAdvertised: advertiseTools });
            break;
        }
        if (round >= cap) {
            // Say why the cap is what it is: "cap reached" is the contract the tests
            // and the caller read for, the rest is what makes it explainable.
            truncated =
                `stopped after ${cap} tool rounds (cap reached: planned ${plannedCap}` +
                    ` from ${namedFileCount(brief)} file(s) named in the brief` +
                    (extensions > 0 ? `; extended ${extensions} time(s) on progress` : "") +
                    ")";
            rounds.push({ result, calls, toolsAdvertised: advertiseTools });
            break;
        }
        rounds.push({ result, calls, toolsAdvertised: advertiseTools });
        // Record the assistant turn WITH its calls so strict OpenAI-compat servers
        // accept the role:"tool" answers that follow.
        messages.push({
            role: "assistant",
            content: resp.content ?? "",
            tool_calls: calls,
        });
        extendOnProgress(round, await runCalls(calls));
    }
    // ---- F6 answer-round rescue ----
    // The loop has read the files and cannot answer. One bounded extra attempt,
    // because the alternative — measured on @cf/openai/gpt-oss-120b, 4 runs in 6 —
    // is discarding every round the run already paid for over a round that walked
    // into a known trap. Gated on tools actually having run: a tool-less failure
    // has nothing to rescue, and a caller asking for a schema gets the same
    // document through the D1 finalize below rather than paying for it twice.
    //
    // `leakedToolCall` is the second way to arrive here with work in hand: the
    // model wrote its call into `content` in a dialect too mangled to execute (or
    // named a tool Nanites never advertised), the loop refused it rather than
    // answering with markup, and the run was about to be discarded
    // with every file it read. That is the same defect reached by a different
    // trigger — measured live on the last tool-terminal shape — and the
    // document rescue is the same answer: the material is already gathered, so
    // hand it over as a fresh turn and take the report from what was read.
    if (!answered &&
        !outputSchema &&
        (answerRoundFailed || leakedToolCall || junkReply) &&
        toolTranscript.length > 0) {
        rescueAttempted = true;
        const reason = pendingBudgetError
            ? pendingBudgetError.code
            : leakedToolCall
                ? "refused_tool_leak"
                : junkReply
                    ? "runaway_reply"
                    : "empty_answer_round";
        onEvent?.("chat.answer_round_failed", { reason, tools_executed: toolTranscript.length });
        // Pinned to the model the answer round already failed on: re-walking the
        // registry would re-ask models that were never in play, at their expense.
        const pin = pendingBudgetError?.details;
        try {
            const result = await route({
                ...roundOpts(false),
                effort: RESCUE_EFFORT,
                // A rebuilt transcript, not the loop's (buildRescueDocument), and the
                // caller's system prompt rather than `loopSystemPrompt` — the latter
                // carries TOOL_LOOP_INSTRUCTION, which is addressed to a model that
                // is still reading.
                messages: buildRescueDocument(brief, toolTranscript),
                systemPrompt: baseSystemPrompt,
            }, provider, pin?.model_id ?? modelId);
            rounds.push({ result, calls: [], toolsAdvertised: false });
            const text = result.response.content ?? "";
            if (text.trim()) {
                finalContent = text;
                answered = true;
                loopIssues.push("answer_round_rescued");
                onEvent?.("chat.rescue_end", { rescued: true, chars: text.length });
            }
            else {
                onEvent?.("chat.rescue_end", { rescued: false, reason: "empty" });
            }
        }
        catch (err) {
            // Best-effort by the same contract as the finalize round: the failure
            // path below reports the original answer-round error, not this one.
            const code = err instanceof NanitesError ? err.code : "provider_error";
            onEvent?.("chat.rescue_end", { rescued: false, failed: code });
        }
    }
    // ---- Structured output ----
    // Only a caller that asked for a schema pays for this. An answer that already
    // conforms costs nothing extra; a non-conforming one buys exactly one
    // tool-free round carrying `response_format` — the answer round, which is
    // where CF's docs want the schema and where tools must be off anyway.
    let structured;
    if (outputSchema) {
        const check = parseStructured(finalContent, outputSchema);
        if (check.ok) {
            structured = { valid: true, finalized: false, problems: [] };
        }
        else {
            const responseFormat = {
                type: "json_schema",
                schema: outputSchema,
                ...(outputSchemaName ? { name: outputSchemaName } : {}),
            };
            const asked = { role: "user", content: FINALIZE_INSTRUCTION };
            // Cloudflare enforces OpenAI's alternation strictly: a `user` turn directly
            // after `tool` results is rejected outright ("Unexpected role 'user' after
            // role 'tool'", HTTP 400 / code 8007 — measured live on the D1 gate). The
            // transcript therefore has to carry the assistant turn first. When the loop
            // produced text, that turn IS the model's answer, being corrected.
            const hasText = finalContent.trim().length > 0;
            // With no text there is no assistant turn to carry the
            // instruction, and hiding it in the system prompt while the transcript
            // still ends on `tool` is the exact shape that returned nothing in 6 of 6
            // measured attempts. Rebuild the tool work as a fresh document instead —
            // one `user` turn, no tool continuation to bail out of — and keep the
            // system-prompt fallback only when there is no transcript to rebuild.
            const useDoc = !hasText && toolTranscript.length > 0;
            const document = useDoc ? buildRescueDocument(brief, toolTranscript, FINALIZE_INSTRUCTION) : null;
            onEvent?.("chat.finalize", { problems: check.problems });
            try {
                const result = await route({
                    ...roundOpts(false, responseFormat),
                    effort: FINALIZE_EFFORT,
                    maxOutputTokens: FINALIZE_OUTPUT_TOKENS,
                    messages: hasText
                        ? [...messages, { role: "assistant", content: finalContent }, asked]
                        : document ?? messages,
                    ...(hasText
                        ? {}
                        : useDoc
                            ? { systemPrompt: baseSystemPrompt }
                            : { systemPrompt: [loopSystemPrompt, FINALIZE_INSTRUCTION].filter(Boolean).join("\n\n") }),
                }, provider, modelId);
                rounds.push({ result, calls: [], toolsAdvertised: false });
                const text = result.response.content ?? "";
                if (text.trim()) {
                    finalContent = text;
                    answered = true;
                }
                const second = parseStructured(finalContent, outputSchema);
                structured = {
                    valid: second.ok,
                    finalized: true,
                    problems: second.ok
                        ? []
                        : text.trim()
                            ? second.problems
                            : [...second.problems, "finalize round returned no text"],
                };
                onEvent?.("chat.finalize_end", { valid: second.ok, problems: structured.problems });
            }
            catch (err) {
                // Best-effort by contract: the caller already holds the loop's answer,
                // and a slow, rate-limited, or unreachable provider must not turn a
                // completed run into a hard failure. A run that dies here loses the
                // only thing it produced, so the miss is reported instead of thrown.
                const code = err instanceof NanitesError ? err.code : "provider_error";
                structured = { valid: false, finalized: true, problems: [`finalize round failed: ${code}`] };
                onEvent?.("chat.finalize_end", { valid: false, failed: code, problems: structured.problems });
            }
        }
    }
    const first = rounds[0]?.result;
    const last = rounds[rounds.length - 1]?.result;
    const roundsDetail = rounds.map((r, i) => ({
        round: i,
        tools_advertised: r.toolsAdvertised,
        infer_ms: r.result.duration_ms,
        tokens_out: r.result.tokens_out,
        finish_reason: r.result.finish_reason ?? null,
    }));
    const tokensIn = rounds.reduce((s, r) => s + r.result.tokens_in, 0);
    const tokensOut = rounds.reduce((s, r) => s + r.result.tokens_out, 0);
    const durationMs = rounds.reduce((s, r) => s + r.result.duration_ms, 0);
    // The loop's contract: a real answer or a structured error. A reply of ""
    // that merely carries `truncated` is what made the old path silently useless
    // — the caller had nothing to show and no error to react to.
    if (!answered) {
        const tools = toolsUsed.map((t) => t.tool);
        // A rescued-and-still-empty run is reported as the answer round it actually
        // was — with the reading it did listed — rather than as a bare provider
        // error that hides six files' worth of work from whoever reads the job.
        if (pendingBudgetError) {
            throw new NanitesError({
                code: pendingBudgetError.code,
                message: pendingBudgetError.message,
                retryable: false,
                details: {
                    ...pendingBudgetError.details,
                    rounds: rounds.length,
                    tools_executed: [...new Set(tools)],
                    rescue_attempted: rescueAttempted,
                    rescued: false,
                },
            });
        }
        throw new NanitesError({
            code: "tool_loop_no_answer",
            message: `Tool loop produced no answer after ${rounds.length} round(s)` +
                (truncated ? ` (${truncated})` : "") +
                (tools.length > 0 ? `; tools executed: ${[...new Set(tools)].join(", ")}` : ""),
            retryable: false,
            details: {
                rounds: rounds.length,
                tools_executed: tools,
                truncated: truncated ?? null,
                ...(leakedToolCall ? { leaked_tool_call: true, leak_parsed: false } : {}),
            },
        });
    }
    onEvent?.("chat.tool_finish", { rounds: rounds.length, tools: toolsUsed.length, truncated: truncated ?? null });
    return {
        reply: finalContent,
        tools_used: toolsUsed,
        model_id: last?.model_id ?? modelId ?? "",
        call_uid: first?.call_uid ?? "",
        ...(last?.call_log_id != null ? { call_log_id: last.call_log_id } : {}),
        provider,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        duration_ms: durationMs,
        rounds: rounds.length,
        rounds_detail: roundsDetail,
        ...(loopIssues.length > 0 ? { issues: loopIssues } : {}),
        ...(truncated ? { truncated } : {}),
        ...(structured ? { structured } : {}),
    };
}
