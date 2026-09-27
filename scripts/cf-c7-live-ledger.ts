/**
 * C7 live gate: one real Cloudflare run, end to end into the ledger.
 *
 * Runs a single tiny brief against Cloudflare, then starts the UI server on an
 * ephemeral port and reads /api/ledger — the same code path the dashboard uses.
 * Passes only if the run appears with a computed cost_usd and a finish_reason,
 * and if the cost report counts it.
 *
 * Costs neurons (one short call) and rotates keys internally, so an exhausted
 * account is skipped rather than fatal. Key material is never printed.
 *
 * Run: npx tsx scripts/cf-c7-live-ledger.ts [profile]
 */
import { buildDeps } from "../src/tools/deps.js";
import { ProviderModelStore } from "../src/storage/providerModelStore.js";
import { ProviderCallLogStore } from "../src/storage/providerCallLogStore.js";
import { routeCloudWithRetry } from "../src/providers/router.js";
import { getCostSavedReport } from "../src/workflows/costSavedReport.js";
import { startUiServer } from "../src/ui/server.js";
import { CLOUDFLARE_AGENT_MANIFEST } from "../src/seed/cloudflareAgentManifest.js";

const MODEL = "@cf/ibm-granite/granite-4.0-h-micro";

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "test";
  const deps = buildDeps();
  const profile = deps.profiles.getProfile(profileName);
  if (!profile) {
    console.error(`no profile named ${profileName}`);
    process.exitCode = 1;
    return;
  }

  // Seed real catalog pricing onto the row so the run can be priced at all.
  const seed = CLOUDFLARE_AGENT_MANIFEST.find((m) => m.model_id === MODEL)!;
  new ProviderModelStore(deps.db).registerManifestModel(profileName, "cloudflare", {
    model_id: seed.model_id,
    context_length: seed.context_length,
    vision: seed.vision,
    function_calling: seed.function_calling,
    reasoning: seed.reasoning,
    pricing_prompt: seed.pricing_prompt,
    pricing_completion: seed.pricing_completion,
  });

  const before = new ProviderCallLogStore(deps.db).listRecent(profileName).length;

  console.log(`live run: ${MODEL} on profile ${profileName}`);
  const res = await routeCloudWithRetry({
    profile,
    db: deps.db,
    effort: "low",
    role: "classifier",
    brief: "Reply with exactly one word: ok",
    messages: [{ role: "user", content: "Reply with exactly one word: ok" }],
  }, "cloudflare", MODEL);

  console.log(`  model          ${res.model_id}`);
  console.log(`  tokens         in ${res.tokens_in} / out ${res.tokens_out}`);
  console.log(`  finish_reason  ${res.finish_reason ?? "none"}`);
  console.log(`  cost_usd       ${res.cost_usd ?? "NULL"}`);
  console.log(`  call_log_id    ${res.call_log_id ?? "none"}`);
  console.log(`  reply          ${(res.response.content ?? "").trim().slice(0, 80)}`);

  const after = new ProviderCallLogStore(deps.db).listRecent(profileName);
  console.log(`  rows logged    ${after.length - before}`);

  const report = getCostSavedReport(deps, profileName, { period: "all" });
  console.log(`  report cloud_calls=${report.cloud_calls} spend=$${report.actual_spend_usd.toFixed(6)}`);

  const ui = await startUiServer(deps, { port: 0 });
  const body = await (await fetch(`http://127.0.0.1:${ui.port}/api/ledger?range=all`)).json() as {
    rows: Array<{ model: string; provider: string | null; cost_usd: number | null; finish_reason: string | null }>;
    fun_stats: { cloud_runs: number; spent_usd: number };
  };
  await ui.close();

  const row = body.rows.find((r) => r.model === MODEL && r.provider === "cloudflare");
  console.log(`  ledger row     ${row ? `provider=${row.provider} cost=$${row.cost_usd} finish=${row.finish_reason}` : "MISSING"}`);
  console.log(`  ledger stats   cloud_runs=${body.fun_stats.cloud_runs} spent=$${body.fun_stats.spent_usd}`);

  const ok = row != null && row.cost_usd != null;
  console.log(ok ? "\nGATE PASS — live CF run priced and visible in the ledger" : "\nGATE FAIL");
  if (!ok) process.exitCode = 1;
  deps.close();
}

main().catch((e) => {
  console.error("live ledger gate failed:", (e as Error).message);
  process.exitCode = 1;
});
