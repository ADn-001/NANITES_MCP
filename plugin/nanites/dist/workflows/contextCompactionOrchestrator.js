/**
 * The `/nanites-btw` compaction pipeline (btw-spec-v2 §2/§6) — the async-job
 * body registered with the Phase-C jobRunner as kind `btw_compact`. It diffs
 * the host session transcript against the `context_cache` diff state, chunks
 * only the new tail, summarizes each chunk through ONE loaded model (the
 * `context_chunk_summarizer`, load-once like `runTestRegimen` — never a
 * per-chunk `run_sub_agent` loop, which would load/unload N times), folds the
 * chunk summaries into the accumulated `context_summary_cache` profile, and
 * stores the chunk-summary corpus for retrieval. One `sub_agent_calls` row is
 * written per model chat so cost-saved reporting still sees every chunk.
 *
 * Cache statuses (§4.1): `cold` (first compaction), `hit_no_diff` (nothing new
 * since last diff), `diffed` (new tail chunked + folded in), and
 * `invalidated_full_rebuild` (the transcript diverged under us — the profile is
 * rebuilt from scratch rather than folding in now-unmappable summaries).
 */
import { acquireInferenceSlot } from "../helpers/inferenceGate.js";
import { NanitesError } from "../helpers/errors.js";
import { clientForProfile } from "../tools/deps.js";
import { cleanReply } from "../helpers/cleaner.js";
import { countTokens, countTokensAccurate } from "../helpers/tokenize.js";
import { usageFromStats, usageEstimate } from "../helpers/tokenCounter.js";
import { GENERATION_IDLE_TIMEOUT_MS } from "../helpers/idleTimeout.js";
import { loadTimeoutFor } from "../helpers/performanceScorer.js";
import { findBestModel } from "./roleMatch.js";
import { acquireModel, unloadModelKey } from "./runSubAgent.js";
/** The summarizer role btw resolves for its map/reduce step. */
export const CONTEXT_CHUNK_SUMMARIZER_ROLE = "context_chunk_summarizer";
/** Target per-chunk budget (approx tokens via the chars/4 seam). Chunking is by
 * whole messages, so a single oversized message can overshoot. */
export const CHUNK_TARGET_TOKENS = 1400;
/** Chat output cap for a chunk/reduce summary (keeps the profile bounded). */
export const SUMMARIZER_OUTPUT_TOKENS = 2048;
/** Deterministic FNV-1a 32-bit hex — stable message identity across calls. */
function messageHash(m) {
    let h = 0x811c9dc5;
    const s = `${m.role} ${m.content}`;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}
function hashAll(messages) {
    return messages.map(messageHash);
}
/** Length of the prefix of `arr` equal to `prefix`. */
function commonPrefixLength(arr, prefix) {
    let n = 0;
    while (n < arr.length && n < prefix.length && arr[n] === prefix[n])
        n++;
    return n;
}
function costFor(profile, tokensIn, tokensOut) {
    return ((tokensIn / 1_000_000) * profile.pricing.input_per_million_usd +
        (tokensOut / 1_000_000) * profile.pricing.output_per_million_usd);
}
export const CHUNK_SUMMARIZER_SYSTEM = "You condense a slice of a working session into a dense, standalone chunk summary. " +
    "Keep every proper noun, file path, decision, numeric constraint, and unresolved thread; " +
    "drop pleasantries and hedging. Preserve the exact wording of critical rules. " +
    "Output only the summary, no preamble.";
export const REDUCE_SYSTEM = "You maintain a living compact profile of a long working session. Given the previous " +
    "profile and one or more newly summarized chunks, fold the new information in: update " +
    "decisions and constraints, append new context, and drop nothing that is still load-bearing. " +
    "Output only the updated profile.";
/** Instructs the held-chat model to cite chunk ranges when present (§11). */
export const GROUNDED_DIRECTIVE = "When a cited chunk range [messages a-b] is present in your context, reference that range " +
    "for claims drawn from it instead of asserting flatly. If a chunk is missing or empty, mark " +
    "the gap rather than inventing its content.";
/** Split the new message tail into whole-message chunks near the token budget. */
function chunkTail(messages, startIndex) {
    const chunks = [];
    let chunkStart = -1;
    let runTokens = 0;
    for (let i = startIndex; i < messages.length; i++) {
        const approx = countTokens(messages[i].content);
        if (chunkStart === -1)
            chunkStart = i;
        runTokens += approx;
        if (runTokens >= CHUNK_TARGET_TOKENS || i === messages.length - 1) {
            const text = messages
                .slice(chunkStart, i + 1)
                .map((m) => `[${m.role}]\n${m.content}`)
                .join("\n\n");
            chunks.push({ msg_start: chunkStart, msg_end: i, text });
            chunkStart = -1;
            runTokens = 0;
        }
    }
    return chunks;
}
function messageText(output) {
    return output
        .filter((o) => o.type === "message")
        .map((o) => o.content)
        .join("\n");
}
function logLedger(deps, profile, profileName, modelId, reply, stats, task, started) {
    const usage = stats !== null ? usageFromStats(stats) : usageEstimate([], reply);
    deps.callLogs.insert({
        profile_name: profileName,
        model_id: modelId,
        task,
        role: CONTEXT_CHUNK_SUMMARIZER_ROLE,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        duration_ms: Date.now() - started,
        cost_usd: costFor(profile, usage.inputTokens, usage.outputTokens),
        ttft_ms: stats !== null ? Math.round(stats.time_to_first_token_seconds * 1000) : null,
        error_code: null,
        context_window: null,
    });
}
/**
 * Compact `messages` into the profile caches. Runs the map+reduce model chats
 * (load-once, unload-once) only when there is genuinely new content;
 * `hit_no_diff` is a pure cache read. This is the job BODY — the caller
 * (jobRunner `btw_compact`, or a direct test call) owns queue/slot semantics.
 */
export async function compactSessionContextUngated(deps, profileName, messages, opts = {}) {
    const profile = deps.profiles.getProfile(profileName);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
    }
    const hashes = hashAll(messages);
    const prior = deps.contextCache.getDiffState(profileName);
    const priorCount = prior?.message_count ?? 0;
    const prevSummary = deps.contextCache.getSummary(profileName);
    const prefix = prior === null ? 0 : commonPrefixLength(hashes, prior.message_hashes);
    // A cached transcript whose prefix we no longer fully match is diverged under
    // us (cleared, /compact-rewritten, or replaced by an unrelated session) — the
    // cached hashes/indices no longer map to any message, and folding into the old
    // profile would stitch two unrelated conversations together. Shorter is the
    // obvious case, but any prefix loss (a longer unrelated transcript diffing
    // from message 0) is equally a full rebuild.
    const diverged = prior !== null && prefix < priorCount;
    const newStart = diverged || prior === null ? 0 : prefix;
    const hasNew = newStart < messages.length;
    if (!hasNew) {
        const cacheStatus = prior === null && prevSummary === null ? "cold" : "hit_no_diff";
        const summary = prevSummary?.summary ?? "";
        return {
            cache_status: cacheStatus,
            new_message_count: 0,
            chunk_count: 0,
            chats_run: 0,
            summary,
            summary_tokens: prevSummary?.summary_tokens ?? countTokens(summary),
            provenance: prevSummary?.chunk_provenance ?? [],
            model_id: "",
        };
    }
    const cacheStatus = prior === null ? "cold" : diverged ? "invalidated_full_rebuild" : "diffed";
    const chunks = chunkTail(messages, newStart);
    const newMessageCount = messages.length - newStart;
    // Registry selection for the summarizer model (the same default branch
    // runSubAgent uses when no explicit model is requested). A partial overlap
    // (e.g. a `summarizer` entry) matches `context_chunk_summarizer`.
    const match = findBestModel(deps.registry.listLocal(profileName), [CONTEXT_CHUNK_SUMMARIZER_ROLE]);
    if (!match) {
        throw new NanitesError({
            code: "no_model_for_role",
            message: `No registry entry matches role "${CONTEXT_CHUNK_SUMMARIZER_ROLE}" — register one before using /nanites-btw`,
            retryable: false,
            details: { role: CONTEXT_CHUNK_SUMMARIZER_ROLE },
        });
    }
    const modelId = match.entry.model_id;
    const idleTimeoutMs = opts.idle_timeout_ms ?? GENERATION_IDLE_TIMEOUT_MS;
    const client = clientForProfile(profile, opts.clientTimeoutMs ? { timeoutMs: opts.clientTimeoutMs } : undefined);
    // Transport eligibility (decided once per run). A dynamic profile that opts
    // into a per-request ttl compacts over /v1/chat/completions + `ttl`: LM Studio
    // JIT-loads the summarizer on the first chunk and keeps it warm across the
    // map/reduce burst, auto-evicting on drain — no acquire, no unload. Otherwise
    // the native load-once/teardown path below is unchanged.
    const ttl_s = profile.inference?.ttl_s ?? 0;
    const ttlEligible = profile.dynamic_model !== false && ttl_s > 0;
    let instanceId = null;
    let loadedThisCall = false;
    let chatsRun = 0;
    const chunkDocs = [];
    let profileText = "";
    try {
        // Load once through the same acquire path as runSubAgent (reuse a resident
        // copy of the summarizer when present; on a sequential tier, evict the idle
        // occupant to make room). The summarizer is never the held QA instance, so
        // it is unloaded in finally — but only when this call did the loading.
        if (!ttlEligible) {
            const loadTimeoutMs = loadTimeoutFor(deps.registry.get(profileName, modelId)?.avg_load_ms ?? null);
            const acquired = await acquireModel(client, profile, modelId, loadTimeoutMs);
            instanceId = acquired.instance_id;
            loadedThisCall = acquired.loaded_this_call;
        }
        // Chat target differs by transport: native addresses the loaded instance id,
        // openai addresses the registry key (JIT-loads by key). openai opts carry
        // the per-request ttl; native stays transport-less.
        const chatTarget = ttlEligible ? modelId : instanceId;
        const chatOpts = ttlEligible ? { transport: "openai", ttl_s } : {};
        // Map step: one chat per chunk against the single loaded instance. The fold
        // base is the previous profile unless this is a full rebuild (its chunks
        // referenced a transcript we can no longer trust).
        let foldBase = cacheStatus === "invalidated_full_rebuild" ? "" : (prevSummary?.summary ?? "");
        for (const chunk of chunks) {
            const started = Date.now();
            const { response } = await client.chat(chatTarget, `[messages ${chunk.msg_start}-${chunk.msg_end}]\n\n${chunk.text}`, { system_prompt: CHUNK_SUMMARIZER_SYSTEM, temperature: 0.2, max_output_tokens: SUMMARIZER_OUTPUT_TOKENS, stream: true }, { idleTimeoutMs, ...chatOpts });
            const summary = cleanReply(messageText(response.output), { maxChars: 100_000 }).text;
            chatsRun++;
            logLedger(deps, profile, profileName, modelId, summary, response.stats, `btw map ${chunk.msg_start}-${chunk.msg_end}`, started);
            foldBase += (foldBase.length > 0 ? "\n\n" : "") + `[messages ${chunk.msg_start}-${chunk.msg_end}] ${summary}`;
            chunkDocs.push({ chunk_id: `c${chunk.msg_start}`, summary, msg_start: chunk.msg_start, msg_end: chunk.msg_end });
        }
        // Reduce step: one fold pass over the accumulated chunks + previous profile,
        // reusing the same loaded instance (no second load).
        const reduceStarted = Date.now();
        const { response: reduceResp } = await client.chat(chatTarget, foldBase, { system_prompt: REDUCE_SYSTEM, temperature: 0.2, max_output_tokens: SUMMARIZER_OUTPUT_TOKENS, stream: true }, { idleTimeoutMs, ...chatOpts });
        profileText = cleanReply(messageText(reduceResp.output), { maxChars: 200_000 }).text;
        chatsRun++;
        logLedger(deps, profile, profileName, modelId, profileText, reduceResp.stats, "btw reduce", reduceStarted);
    }
    finally {
        // Unload exactly once, and only if this call loaded it — a pre-resident
        // summarizer we reused stays put for the profile's ordinary eviction rules.
        if (instanceId !== null && loadedThisCall) {
            if (profile.dynamic_model !== false) {
                // Dynamic profile: reclaim the whole key so a JIT sibling instance is
                // not left idle after compaction (same exposure as runTestRegimen).
                await unloadModelKey(client, modelId).catch(() => { });
            }
            else {
                await client.unloadModel({ instance_id: instanceId }).catch(() => { });
            }
        }
    }
    const summaryTokens = await countTokensAccurate(profileText, { modelId });
    const provenance = chunkDocs.map((c) => ({
        chunk_id: c.chunk_id,
        msg_start: c.msg_start,
        msg_end: c.msg_end,
        embedding_row_id: null,
    }));
    // Persist: advance the diff watermark, store the folded profile + provenance,
    // and replace the retrievable chunk-summary corpus for this profile.
    deps.contextCache.setDiffState(profileName, {
        message_hashes: hashes,
        message_count: messages.length,
        cached_through_index: messages.length,
    });
    deps.contextCache.setSummary(profileName, {
        summary: profileText,
        summary_tokens: summaryTokens,
        times_diffed_since_reduce: 0,
        chunk_provenance: provenance,
    });
    deps.chunkEmbeddings.replaceChunks(profileName, chunkDocs);
    return {
        cache_status: cacheStatus,
        new_message_count: newMessageCount,
        chunk_count: chunks.length,
        chats_run: chatsRun,
        summary: profileText,
        summary_tokens: summaryTokens,
        provenance,
        model_id: modelId,
    };
}
// CP-4: compaction holds a model for its summarization inference, so it takes
// the same per-profile gate runSubAgent uses.
export async function compactSessionContext(deps, profileName, messages, opts = {}) {
    const release = await acquireInferenceSlot(profileName);
    try {
        return await compactSessionContextUngated(deps, profileName, messages, opts);
    }
    finally {
        release();
    }
}
