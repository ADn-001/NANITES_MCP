/**
 * F6 probe. Unlike `cf-role-probe.ts` — a hand-rolled raw-`fetch` loop
 * with a fixed system prompt, a two-round cap, and no budget retry — this drives
 * the REAL `runCloudToolLoop` with the default route, so `planCloudInference`,
 * `buildCloudChatRequest`, `chatWithBudgetRetry`, the model-scoped router walk
 * and the production system prompt all run exactly as they do in production.
 *
 * The raw bodies still have to be seen: `client.chat` parses and discards them,
 * and on the throw path there is no `RouteResult` at all. So the probe tees
 * `globalThis.fetch`, cloning each response before the client consumes it. That
 * is the only way to observe BOTH budget attempts (16384 then 32768) that
 * `chatWithBudgetRetry` makes inside a single loop round.
 *
 * Writes its own standalone report (`--out`, default `probe_latest.md`),
 * which is then spliced into the assembled answer-round probe report as a new
 * `## Run N` section — that file is the record of every run and is
 * never the write target.
 *
 * Run: npx tsx scripts/cf-f6-probe.ts [profile] [--runs N] [--post-fix] [--out PATH]
 */
import { writeFileSync } from "node:fs";
import { openNanitesDb } from "../src/storage/db.js";
import { ProfileManager } from "../src/storage/profileManager.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { RolePinStore } from "../src/storage/rolePinStore.js";
import { runCloudToolLoop } from "../src/providers/cloudToolLoop.js";
import { parseChatResponse } from "../src/providers/client.js";
import type { FsGrant } from "../src/providers/fsTools.js";
import type { Effort } from "../src/helpers/inferencePlanner.js";
import type { Profile } from "../src/storage/profileDefaults.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * The verbatim brief of the production run that actually raised
 * `provider_budget_exhausted` (jobs 43/44, 2026-09-11). Brief length is the
 * whole point: a one-file brief finishes in 3-5 rounds while tools are still
 * advertised, so the forced tool-less answer round — the only round that runs
 * at the REQUESTED effort, and the one the 16384/32768 error names — never
 * happens. This brief walks files one per round until the cap is reached.
 */
const BRIEF_ROOT = process.env.NANITES_PROBE_FS_ROOT ?? "the repository root";
const BRIEF = `Read-only code audit. Filesystem tools available: list_directory, search_files, get_file_info, read_file (root ${BRIEF_ROOT}). DO NOT write, create, or modify any file.

Read every one of these files in full:
- src/index.ts
- src/server/buildServer.ts
- src/server/prompts.ts
- src/server/commandsManifest.ts
- src/tools/toolkit.ts
- src/tools/deps.ts
- src/tools/responses.ts
- src/tools/providers.ts

Find code that is improper, invalid, or mangled. Specifically:
1. Merge-conflict markers (<<<<<<<, =======, >>>>>>>) or leftover duplicated blocks.
2. Truncated or syntactically broken TypeScript (unclosed braces/parens, a function body cut off at end of file).
3. Encoding damage: raw control bytes, U+FFFD replacement characters, mojibake.
4. Dead or unreachable code, TODO/FIXME/XXX stubs admitting unfinished work, functions declared but never registered or exported.
5. Inconsistencies between a tool's registered name, its input schema, and its handler.
6. Any place a secret (auth_token, access_token, api key) is returned to the MCP caller instead of masked.

Output ONLY finding lines, exactly:
<path>:<line> — <high|med|low> — <problem> — <fix>

For a file with no defect emit exactly: clean: <path>
No prose, no preamble, no summary. Maximum 30 lines.`;

/**
 * The role the production failure actually ran under. `reviewer` and `code_qa`
 * are both in the planner's DIFFICULT_ROLES set, so at medium effort they take
 * the identical reasoning path — the role name is not the variable here, the
 * brief length is.
 */
const ROLE = "reviewer";
const MODEL = "@cf/openai/gpt-oss-120b";
const EFFORT: Effort = "medium";
const FS_ROOT = process.env.NANITES_PROBE_FS_ROOT ?? process.cwd();
const VERBATIM_CAP = 2_000;
/**
 * Where a run is written when `--out` is omitted. Deliberately NOT the
 * assembled probe report: that file is the record of
 * every run (pre-fix, post-fix v1, post-fix v2 samples), and defaulting to it
 * would erase the evidence a new run is supposed to be compared against. Splice
 * the output into the assembled report as its own `## Run N` section.
 */
const DEFAULT_OUT = "probe_latest.md";
/** Marks the production loop's own instruction riding in the system prompt. */
const LOOP_INSTRUCTION_MARKER = "produce your final report";

interface AttemptRecord {
  seq: number;
  call_uid: string | null;
  /** Second attempt of the same call_uid = `chatWithBudgetRetry` doubling. */
  retry: boolean;
  http: number;
  max_completion_tokens: number | null;
  reasoning_effort: string | null;
  tools_advertised: number;
  last_role: string | null;
  loop_instruction: boolean;
  finish_reason: string | null;
  content: string;
  reasoning_chars: number;
  calls: number;
  tokens_out: number;
  parse_error?: string;
}

interface RunRecord {
  run: number;
  attempts: AttemptRecord[];
  /** Tool executions observed via onEvent — the loop discards its own list on throw. */
  tools_executed: string[];
  rounds_seen: number;
  error: { code: string; message: string; details: unknown } | null;
  reply_chars: number;
  wall_ms: number;
  /** F6 rescue, observed from the loop's own events. */
  answer_round_failed: boolean;
  rescue_attempted: boolean;
  rescued: boolean;
}

function bodyMessages(body: string | null): Array<{ role?: string; content?: unknown }> {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

function callUidOf(messages: Array<{ content?: unknown }>): string | null {
  for (const m of messages) {
    if (typeof m.content !== "string") continue;
    const match = /\[INTERNAL_CALL_UID: ([^\]]+)\]/.exec(m.content);
    if (match) return match[1]!;
  }
  return null;
}

function systemHasLoopInstruction(messages: Array<{ role?: string; content?: unknown }>): boolean {
  return messages.some(
    (m) =>
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.toLowerCase().includes(LOOP_INSTRUCTION_MARKER),
  );
}

async function runOnce(
  run: number,
  profile: Profile,
  db: DatabaseSync,
  seqRef: { n: number },
): Promise<RunRecord> {
  const attempts: AttemptRecord[] = [];
  const toolsExecuted: string[] = [];
  const seenUids = new Set<string>();
  const record: RunRecord = {
    run,
    attempts,
    tools_executed: toolsExecuted,
    rounds_seen: 0,
    error: null,
    reply_chars: 0,
    wall_ms: 0,
    answer_round_failed: false,
    rescue_attempted: false,
    rescued: false,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const messages = bodyMessages(bodyText);
    const uid = callUidOf(messages);
    const retry = uid !== null && seenUids.has(uid);
    if (uid !== null) seenUids.add(uid);
    let reqFields: {
      max_completion_tokens?: number;
      max_tokens?: number;
      reasoning_effort?: string;
      tools?: unknown[];
    } = {};
    try {
      reqFields = JSON.parse(bodyText ?? "{}") as typeof reqFields;
    } catch {
      /* keep empty */
    }

    const res = await originalFetch(input as RequestInfo, init);
    // Clone BEFORE the client reads the body, or this throws.
    let parsed: unknown = null;
    let parseError: string | undefined;
    try {
      parsed = await res.clone().json();
    } catch (err) {
      parseError = (err as Error).message;
    }

    const attempt: AttemptRecord = {
      seq: seqRef.n++,
      call_uid: uid,
      retry,
      http: res.status,
      max_completion_tokens: reqFields.max_completion_tokens ?? reqFields.max_tokens ?? null,
      reasoning_effort: reqFields.reasoning_effort ?? null,
      tools_advertised: Array.isArray(reqFields.tools) ? reqFields.tools.length : 0,
      last_role: messages.length > 0 ? (messages[messages.length - 1]?.role ?? null) : null,
      loop_instruction: systemHasLoopInstruction(messages),
      finish_reason: null,
      content: "",
      reasoning_chars: 0,
      calls: 0,
      tokens_out: 0,
      ...(parseError ? { parse_error: parseError } : {}),
    };
    if (parsed !== null) {
      try {
        const resp = parseChatResponse(parsed);
        attempt.finish_reason = resp.finish_reason ?? null;
        attempt.content = typeof resp.content === "string" ? resp.content : "";
        attempt.reasoning_chars = (resp.reasoning_content ?? resp.reasoning ?? "").length;
        attempt.calls = (resp.tool_calls ?? []).length;
        attempt.tokens_out = resp.usage?.completion_tokens ?? 0;
      } catch (err) {
        attempt.parse_error = `parseChatResponse: ${(err as Error).message}`;
      }
    }
    attempts.push(attempt);
    return res;
  }) as typeof fetch;

  const startedAt = Date.now();
  const fsGrant: FsGrant = {
    root: FS_ROOT,
    allowed_tools: ["read_file", "list_directory", "search_files", "get_file_info"],
  };

  try {
    const result = await runCloudToolLoop({
      profile,
      db,
      provider: "cloudflare",
      modelId: MODEL,
      effort: EFFORT,
      role: ROLE,
      brief: BRIEF,
      fsGrant,
      onEvent: (phase, payload) => {
        if (phase === "chat.tool") toolsExecuted.push(String(payload.tool));
        if (phase === "chat.round") record.rounds_seen = Number(payload.round) + 1;
        if (phase === "chat.answer_round_failed") record.answer_round_failed = true;
        if (phase === "chat.rescue_end") {
          record.rescue_attempted = true;
          record.rescued = payload.rescued === true;
        }
      },
    });
    record.reply_chars = result.reply.length;
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: unknown };
    record.error = {
      code: e.code ?? "unknown",
      message: e.message ?? String(err),
      details: e.details ?? null,
    };
  } finally {
    globalThis.fetch = originalFetch;
    record.wall_ms = Date.now() - startedAt;
  }

  return record;
}

/** Shape A = the evidenced defect: an answer round that produced nothing, on a run that did tool work. */
function isShapeA(rec: RunRecord): boolean {
  return rec.tools_executed.length > 0 && (rec.error?.code === "provider_budget_exhausted" || rec.reply_chars === 0);
}

function renderDoc(profile: string, runs: RunRecord[], label: string): string {
  const lines: string[] = [];
  const shapeA = runs.filter(isShapeA).length;
  const rescued = runs.filter((r) => r.rescued).length;
  const failedRounds = runs.filter((r) => r.answer_round_failed).length;
  lines.push(`# 45 — Cloudflare F6 Answer-Round Probe (${label})`);
  lines.push("");
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Profile: \`${profile}\` | generated by \`scripts/cf-f6-probe.ts\``);
  lines.push("");
  lines.push("Drives the REAL `runCloudToolLoop` with the default route — production");
  lines.push("planning, production system prompt, production budget retry — against");
  lines.push(`\`${MODEL}\` as \`${ROLE}\` at \`${EFFORT}\` effort. Each provider attempt's`);
  lines.push("raw body is captured by teeing `globalThis.fetch`, because the throw path");
  lines.push("produces no `RouteResult` and the client discards the body.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`Runs: ${runs.length} | runs with tool work but no answer (Shape A): **${shapeA}**`);
  lines.push("");
  lines.push(
    `Answer rounds that failed: **${failedRounds}** | rescue attempts: **${runs.filter((r) => r.rescue_attempted).length}** | rescued: **${rescued}**`,
  );
  lines.push("");
  lines.push("The empty is intermittent, so a clean run is NOT evidence of absence — read");
  lines.push("the per-run rows, not just this tally.");
  lines.push("");
  lines.push("| run | seq | retry | http | max_tok | reasoning_effort | tools | last role | loop instr | finish | chars | reason_chars | calls | tok_out |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    if (r.attempts.length === 0) {
      lines.push(`| ${r.run} | - | - | - | - | - | - | - | - | - | - | - | - | - |`);
      continue;
    }
    for (const a of r.attempts) {
      lines.push(
        `| ${r.run} | ${a.seq} | ${a.retry} | ${a.http} | ${a.max_completion_tokens ?? "-"} | ${a.reasoning_effort ?? "-"} | ${a.tools_advertised} | ${a.last_role ?? "-"} | ${a.loop_instruction} | ${a.finish_reason ?? "-"} | ${a.content.length} | ${a.reasoning_chars} | ${a.calls} | ${a.tokens_out} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Run outcomes");
  lines.push("");
  for (const r of runs) {
    lines.push(
      `- **run ${r.run}** — ${r.rounds_seen} loop round(s), tools executed ` +
        `${r.tools_executed.length > 0 ? `[${r.tools_executed.join(", ")}]` : "none"}, ` +
        `reply ${r.reply_chars} chars, ${r.wall_ms} ms` +
        (r.rescue_attempted ? `, rescue ${r.rescued ? "SUCCEEDED" : "failed"}` : "") +
        (r.error ? `, ERROR \`${r.error.code}\`: ${r.error.message}` : ", no error"),
    );
  }
  lines.push("");
  lines.push("## Verbatim content");
  lines.push("");
  for (const r of runs) {
    lines.push(`### run ${r.run}`);
    lines.push("");
    for (const a of r.attempts) {
      lines.push(
        `**seq ${a.seq}** — call_uid \`${a.call_uid ?? "-"}\`${a.retry ? " (budget retry)" : ""}, ` +
          `finish \`${a.finish_reason ?? "-"}\`, reasoning ${a.reasoning_chars} chars`,
      );
      lines.push("");
      if (a.parse_error) lines.push(`> note: ${a.parse_error}`);
      lines.push("```");
      lines.push(a.content.length > VERBATIM_CAP ? `${a.content.slice(0, VERBATIM_CAP)}\n[truncated]` : a.content);
      lines.push("```");
      lines.push("");
    }
    if (r.error) {
      lines.push("```json");
      lines.push(JSON.stringify(r.error, null, 2).slice(0, VERBATIM_CAP));
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "test";
  const runsArg = process.argv.indexOf("--runs");
  const runsCount = runsArg >= 0 ? Number(process.argv[runsArg + 1] ?? 6) : 6;
  // Pre-fix and post-fix runs are both evidence and cannot share a
  // file, or the second run erases what the first one proved.
  const outArg = process.argv.indexOf("--out");
  const outPath = outArg >= 0 ? (process.argv[outArg + 1] ?? DEFAULT_OUT) : DEFAULT_OUT;
  const label = process.argv.includes("--post-fix") ? "post-fix" : "pre-fix";

  const { db, close } = openNanitesDb();
  const profile = new ProfileManager().getProfile(profileName);
  if (!profile) {
    console.error(`no such profile: ${profileName}`);
    close();
    process.exitCode = 1;
    return;
  }
  const keys = new ProviderKeyStore(db).availableKeys(profileName, "cloudflare");
  if (keys.length === 0) {
    console.error(`No available Cloudflare key for profile ${profileName} — aborting.`);
    close();
    process.exitCode = 1;
    return;
  }
  const pin = new RolePinStore(db).get(profileName, ROLE);
  console.log(
    `profile=${profileName} model=${MODEL} role=${ROLE} effort=${EFFORT} runs=${runsCount}` +
      ` pin=${pin ? `${pin.provider}/${pin.model_id}` : "(none)"}`,
  );

  const seqRef = { n: 1 };
  const runs: RunRecord[] = [];
  for (let i = 1; i <= runsCount; i++) {
    const rec = await runOnce(i, profile, db, seqRef);
    runs.push(rec);
    console.log(
      `  run ${i}: rounds=${rec.rounds_seen} tools=${rec.tools_executed.length} ` +
        `reply=${rec.reply_chars} err=${rec.error?.code ?? "-"} (${rec.wall_ms}ms)`,
    );
    for (const a of rec.attempts) {
      console.log(
        `    seq ${a.seq} retry=${a.retry} http=${a.http} max_tok=${a.max_completion_tokens ?? "-"} ` +
          `finish=${a.finish_reason ?? "-"} chars=${a.content.length} reason=${a.reasoning_chars} calls=${a.calls}`,
      );
    }
  }

  close();
  const doc = renderDoc(profileName, runs, label);
  writeFileSync(outPath, doc, "utf8");
  const shapeA = runs.filter(isShapeA).length;
  console.log(`\nwrote ${outPath}`);
  console.log(`Shape A (tool work, no answer): ${shapeA}/${runs.length}`);
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
});
