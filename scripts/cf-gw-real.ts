/**
 * Real-transcript loop probe: compares the measured empty-answer rate across
 * FS roots, optionally routed through the diagnostic AI Gateway with full
 * correlation-header capture.
 *
 * Mode `--gw off` (DIRECT, default for the path experiment): drives the real
 * `runCloudToolLoop` with the real 8-file audit brief and no gateway header, so
 * the answer-round empty rate is measured directly, unconfounded by the
 * intermittent AI Gateway routing flake (400/2001).
 *
 * Mode `--gw on`: injects `cf-aig-gateway-id` + cache/retry/log headers and
 * `cf-aig-metadata` (a run-scoped `internal_call_uid`), and captures the gateway
 * correlation headers (`cf-aig-event-id`, `cf-aig-log-id`, `cf-aig-step`,
 * `cf-aig-cache-status`) from EVERY response including failures — the evidence
 * for the gateway support case. Requires CF_ACCOUNT_ID, CF_API_TOKEN,
 * CF_GATEWAY_ID in the environment; the model token rides in the vault key the
 * loop selects.
 *
 * Tool grant is read-only (list_directory/search_files/get_file_info/read_file);
 * only the audit's 8 named files are read; no writes.
 *
 * Run: npx tsx scripts/cf-gw-real.ts [profile] [--runs N] [--root <path>] [--gw on|off]
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProfileManager } from "../src/storage/profileManager.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { RolePinStore } from "../src/storage/rolePinStore.js";
import { runCloudToolLoop } from "../src/providers/cloudToolLoop.js";
import type { FsGrant } from "../src/providers/fsTools.js";
import type { Effort } from "../src/helpers/inferencePlanner.js";

function briefFor(root: string): string {
  return `Read-only code audit. Filesystem tools available: list_directory, search_files, get_file_info, read_file (root ${root}). DO NOT write, create, or modify any file.

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
}

const ROLE = "reviewer";
const MODEL = "@cf/openai/gpt-oss-120b";
const EFFORT: Effort = "medium";
const DEFAULT_ROOT = process.env.NANITES_PROBE_FS_ROOT ?? process.cwd();

interface RunOutcome {
  run: number;
  reply_chars: number;
  reply_len: number;
  wall_ms: number;
  error: { code: string; message: string } | null;
  rounds: number;
  answer_round_failed: boolean;
  rescue_attempted: boolean;
  rescued: boolean;
}

interface CorrRecord {
  http: number | null;
  event_id: string | null;
  log_id: string | null;
  step: string | null;
  cache_status: string | null;
  body_preview: string;
}

async function main() {
  const profileName = process.argv[2] ?? "test";
  const runsArg = process.argv.indexOf("--runs");
  const runsCount = runsArg >= 0 ? Number(process.argv[runsArg + 1] ?? 4) : 4;
  const rootArg = process.argv.indexOf("--root");
  const root = rootArg >= 0 ? (process.argv[rootArg + 1] ?? DEFAULT_ROOT) : DEFAULT_ROOT;
  const gwArg = process.argv.indexOf("--gw");
  const gwOn = gwArg < 0 ? true : process.argv[gwArg + 1] !== "off";
  const gatewayId = process.env.CF_GATEWAY_ID ?? "nanites-empty-answer-probe";
  const uid = `probe-${Date.now()}`;

  const { db, close } = openNanitesDb();
  const profile = new ProfileManager().getProfile(profileName);
  if (!profile) { console.error(`no such profile: ${profileName}`); close(); process.exitCode = 1; return; }
  const keys = new ProviderKeyStore(db).availableKeys(profileName, "cloudflare");
  if (keys.length === 0) { console.error(`No available Cloudflare key for profile ${profileName} — aborting.`); close(); process.exitCode = 1; return; }
  const pin = new RolePinStore(db).get(profileName, ROLE);
  console.log(`profile=${profileName} model=${MODEL} role=${ROLE} effort=${EFFORT} runs=${runsCount} root=${root} gw=${gwOn?"on":"off"} uid=${uid}`);

  const corr: CorrRecord[] = [];
  const outcomes: RunOutcome[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/ai/v1/chat/completions") && init) {
      const headers = new Headers(init.headers);
      if (gwOn) {
        headers.set("cf-aig-gateway-id", gatewayId);
        headers.set("cf-aig-skip-cache", "true");
        headers.set("cf-aig-max-attempts", "1");
        headers.set("cf-aig-collect-log-payload", "true");
        headers.set("cf-aig-metadata", JSON.stringify({ internal_call_uid: uid }));
      }
      const started = Date.now();
      const res = await originalFetch(input, { ...init, headers });
      const rec: CorrRecord = {
        http: res.status,
        event_id: res.headers.get("cf-aig-event-id"),
        log_id: res.headers.get("cf-aig-log-id"),
        step: res.headers.get("cf-aig-step"),
        cache_status: res.headers.get("cf-aig-cache-status") ?? res.headers.get("cf-cache-status"),
        body_preview: "",
      };
      // Capture the body for failures (2001/5xx) so the CF case has evidence.
      if (!res.ok) {
        const text = await res.clone().text();
        rec.body_preview = text.slice(0, 240);
      }
      corr.push(rec);
      console.log(`    corr http=${rec.http} event=${rec.event_id ?? "∅"} log=${rec.log_id ?? "∅"} step=${rec.step ?? "∅"} cache=${rec.cache_status ?? "∅"}${!res.ok ? ` body=${rec.body_preview.replace(/\s+/g, " ")}` : ""} ms=${Date.now() - started}`);
      return res;
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const fsGrant: FsGrant = { root, allowed_tools: ["read_file", "list_directory", "search_files", "get_file_info"] };
  const brief = briefFor(root);

  for (let run = 1; run <= runsCount; run++) {
    const out: RunOutcome = { run, reply_chars: 0, reply_len: 0, wall_ms: 0, error: null, rounds: 0, answer_round_failed: false, rescue_attempted: false, rescued: false };
    const startedAt = Date.now();
    try {
      const result = await runCloudToolLoop({
        profile, db, provider: "cloudflare", modelId: MODEL, effort: EFFORT, role: ROLE, brief, fsGrant,
        onEvent: (phase, payload) => {
          if (phase === "chat.round") out.rounds = Number(payload.round) + 1;
          if (phase === "chat.answer_round_failed") out.answer_round_failed = true;
          if (phase === "chat.rescue_end") { out.rescue_attempted = true; out.rescued = payload.rescued === true; }
        },
      });
      out.reply_chars = result.reply.length;
      out.reply_len = result.reply.trim().split(/\s+/).length;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      out.error = { code: e.code ?? "unknown", message: e.message ?? String(err) };
    } finally {
      out.wall_ms = Date.now() - startedAt;
    }
    outcomes.push(out);
    console.log(
      `  run ${run}: rounds=${out.rounds} reply_words=${out.reply_len} reply_chars=${out.reply_chars} answer_fail=${out.answer_round_failed} ` +
      `rescue=${out.rescued ? "ok" : out.rescue_attempted ? "failed" : "none"} err=${out.error?.code ?? "-"} (${out.wall_ms}ms)`,
    );
  }

  globalThis.fetch = originalFetch;
  close();
  const shapeA = outcomes.filter((o) => o.reply_chars === 0 && o.error?.code === "provider_budget_exhausted").length;
  const emptyAny = outcomes.filter((o) => o.reply_chars === 0).length;
  const rescuedOk = outcomes.filter((o) => o.rescued).length;
  const withCorr = corr.filter((c) => c.http !== null).length;
  console.log(`\nroot=${root} gw=${gwOn?"on":"off"} runs=${runsCount}`);
  console.log(`  Shape A (tool work, empty, provider_budget_exhausted): ${shapeA}/${runsCount}`);
  console.log(`  any empty reply (reply_chars==0): ${emptyAny}/${runsCount}`);
  console.log(`  rescued (non-empty): ${rescuedOk}/${runsCount}`);
  console.log(`  mean reply_words: ${(outcomes.reduce((s, o) => s + o.reply_len, 0) / Math.max(1, outcomes.length)).toFixed(1)}`);
  if (gwOn) {
    console.log(`  correlation captures: ${withCorr}/${corr.length} (http + event/log/step headers)`);
    const failHits = corr.filter((c) => c.http !== null && c.http >= 400);
    console.log(`  non-2xx responses: ${failHits.length} — event_id present: ${failHits.filter((c) => c.event_id).length}`);
  }
}

main().catch((e) => { console.error("probe failed:", (e as Error).message); process.exitCode = 1; });