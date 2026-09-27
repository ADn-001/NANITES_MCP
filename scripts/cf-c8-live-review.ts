/**
 * C8 / sprint-exit live gate: a real cloud sub-agent reviews real
 * source files through the fs tool loop and returns a structured report.
 *
 * This is the sprint's stated exit criterion, so the assertions are the ones the
 * plan names: the run completes on a Cloudflare model, the reply is non-empty
 * (never the `reply: ""` shape the old path could return), the loop actually
 * read the files rather than hallucinating them, and the run lands in the ledger
 * priced. Needs the profile's `tools.enabled` + `tools.fs` grant; the `test`
 * profile already carries one rooted at the repo.
 *
 * Costs neurons (a multi-round tool loop). Keys rotate, so an exhausted account
 * is retired rather than fatal. Key material is never read or printed.
 *
 * Run: npx tsx scripts/cf-c8-live-review.ts [profile]
 */
import { buildDeps } from "../src/tools/deps.js";
import { RolePinStore } from "../src/storage/rolePinStore.js";
import { runSubAgent } from "../src/workflows/runSubAgent.js";
import { getCostSavedReport } from "../src/workflows/costSavedReport.js";
import { startUiServer } from "../src/ui/server.js";

const FILES = [
  "src/helpers/cleaner.ts",
  "src/storage/callLogStore.ts",
  "src/storage/providerCallLogStore.ts",
  "src/workflows/costSavedReport.ts",
  "src/helpers/inferencePlanner.ts",
];

const BRIEF = [
  "Review these five files for correctness defects.",
  ...FILES.map((f) => `- ${f}`),
  "",
  "Read each file with the read_file tool before judging it. Then reply with a JSON object:",
  '{"findings": [{"file": "<path>", "line": <number>, "severity": "high|medium|low", "defect": "<one sentence>"}], "summary": "<two sentences>"}',
  "Report at most 5 findings. Output the JSON only — no prose before or after.",
].join("\n");

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "test";
  const deps = buildDeps();
  const profile = deps.profiles.getProfile(profileName);
  if (!profile) {
    console.error(`no profile named ${profileName}`);
    process.exitCode = 1;
    return;
  }
  if (!profile.tools?.enabled || !profile.tools.fs) {
    console.error(`profile ${profileName} has no fs grant — the cloud tool loop is the thing under test`);
    process.exitCode = 1;
    return;
  }

  const pin = new RolePinStore(deps.db).list(profileName).find((p) => p.role === "reviewer");
  console.log(`reviewer pin   ${pin ? `${pin.provider}/${pin.model_id}` : "(none — dynamic CF selection)"}`);

  const before = getCostSavedReport(deps, profileName, { period: "all" });
  console.log("brief:" + BRIEF.split("\n").map((l) => `\n  ${l}`).join(""));

  const started = Date.now();
  const res = await runSubAgent(deps, profileName, BRIEF, { roles: ["reviewer"] });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nmodel          ${res.model_id}`);
  console.log(`instance       ${res.instance_id}`);
  console.log(`elapsed        ${secs}s`);
  console.log(`tools used     ${res.tools_used.length} -> ${[...new Set(res.tools_used.map((t) => t.tool))].join(", ")}`);
  console.log(`tokens         in ${res.token_usage.inputTokens} / out ${res.token_usage.outputTokens}`);
  console.log(`call_log_id    ${res.call_log_id}`);
  console.log(`reply chars    ${res.reply.trim().length}`);
  console.log(`\n--- reply ---\n${res.reply.trim().slice(0, 1200)}\n--- end ---`);

  const after = getCostSavedReport(deps, profileName, { period: "all" });
  const ui = await startUiServer(deps, { port: 0 });
  const body = (await (await fetch(`http://127.0.0.1:${ui.port}/api/ledger?range=all`)).json()) as {
    rows: Array<{ model: string; provider: string | null; cost_usd: number | null; finish_reason: string | null }>;
    fun_stats: { cloud_runs: number; spent_usd: number };
  };
  await ui.close();

  const row = body.rows.find((r) => r.model === res.model_id && r.provider === "cloudflare");
  console.log(`\nledger row     ${row ? `provider=${row.provider} cost=$${row.cost_usd} finish=${row.finish_reason}` : "MISSING"}`);
  console.log(`cloud calls    ${before.cloud_calls} -> ${after.cloud_calls}`);
  console.log(`ledger stats   cloud_runs=${body.fun_stats.cloud_runs} spent=$${body.fun_stats.spent_usd.toFixed(6)}`);

  const reads = res.tools_used.filter((t) => t.tool === "read_file").length;
  const checks: Array<[string, boolean]> = [
    ["cloud run (never fell back to local)", res.instance_id.startsWith("cloud:")],
    ["non-empty reply (no empty-reply path)", res.reply.trim().length >= 200],
    ["loop read at least 4 files", reads >= 4],
    ["run is in the ledger with a cost", row != null && row.cost_usd != null],
    ["run is counted by the cost report", after.cloud_calls > before.cloud_calls],
  ];
  console.log("");
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);

  const ok = checks.every(([, v]) => v);
  console.log(ok ? "\nGATE PASS — cloud tool-loop review end to end" : "\nGATE FAIL");
  if (!ok) process.exitCode = 1;
  deps.close();
}

main().catch((e) => {
  // The envelope matters as much as the text: a raw "fetch failed" is a
  // provider_network_error with retryable:true, not an unstructured throw.
  const err = e as { code?: string; message?: string; retryable?: boolean };
  console.error(`live review gate failed: [${err.code ?? "unstructured"}] ${err.message ?? String(e)}`);
  console.error(`  retryable=${err.retryable ?? "?"} (a transport error here is the network's, not the code's)`);
  process.exitCode = 1;
});
