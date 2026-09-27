/**
 * D4 live gate: pricing on discovery, not only on seed.
 *
 * The claim is narrow and checkable: a catalog model the seed manifest does not
 * cover logs a real `cost_usd` on its first run **without** anyone re-seeding
 * the fleet by hand — which is exactly the workaround the pre-fix exit needed,
 * because `pricing_prompt`/`pricing_completion` had only one writer and it was
 * the manifest.
 *
 * Steps, in the order the gate cares about them:
 *   1. assert the target model has no manifest entry (else the test proves nothing),
 *   2. run the real discovery path (`discoverProviderModels`, the same one the
 *      MCP tool calls) against the live catalog — no seeding anywhere,
 *   3. print the row's rates and require an output rate to exist,
 *   4. one cheap cloud call on that model,
 *   5. require the ledger row's `cost_usd` to be non-null and to match the
 *      tokens at the discovered rates.
 *
 * Writes to the profile's `provider_models` table (that IS the feature) and adds
 * one small cloud call. Key material is never read or printed here.
 *
 * Run: npx tsx scripts/cf-d4-price-live.ts [profile] [model_id]
 */
import { buildDeps } from "../src/tools/deps.js";
import { ProviderModelStore } from "../src/storage/providerModelStore.js";
import { discoverProviderModels } from "../src/tools/providers.js";
import { runSubAgent } from "../src/workflows/runSubAgent.js";
import { CLOUDFLARE_AGENT_MANIFEST } from "../src/seed/cloudflareAgentManifest.js";

/** Cheap, catalog-priced (in 0.0509 / out 0.335 per M on the 2026-09-10 catalog). */
const DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "test";
  const modelId = process.argv[3] ?? DEFAULT_MODEL;
  const deps = buildDeps();
  const profile = deps.profiles.getProfile(profileName);
  if (!profile) {
    console.error(`no profile named ${profileName}`);
    process.exitCode = 1;
    return;
  }
  const models = new ProviderModelStore(deps.db);

  const seeded = CLOUDFLARE_AGENT_MANIFEST.some((m) => m.model_id === modelId);
  console.log(`profile        ${profileName}`);
  console.log(`model          ${modelId}`);
  console.log(`manifest entry ${seeded ? "PRESENT (gate proves nothing)" : "absent — discovery is its only price source"}`);

  const before = models.getModel(profileName, "cloudflare", modelId);
  console.log(
    `row before     ${before ? `in=${before.pricing_prompt} out=${before.pricing_completion} registered=${before.is_registered}` : "no row"}`,
  );

  if (deps.profiles.getActiveProfile()?.name !== profileName) {
    deps.profiles.switchProfile(profileName);
  }
  const discovery = await discoverProviderModels(deps, "cloudflare");
  console.log(`discovery      ${discovery.discovered} models from the live catalog (no seeding)`);

  const row = models.getModel(profileName, "cloudflare", modelId)!;
  console.log(`row after      in=${row.pricing_prompt} out=${row.pricing_completion}`);

  const res = await runSubAgent(deps, profileName, "Reply with the single word: ok", {
    provider: "cloudflare",
    model_id: modelId,
    effort: "low",
  });
  const ledger = deps.providerCallLogs.listRecent(profileName, { limit: 10 });
  const call = ledger.find((c) => c.model_id === modelId) ?? null;

  const tokensIn = call?.tokens_in ?? 0;
  const tokensOut = call?.tokens_out ?? 0;
  const expected =
    (tokensIn / 1_000_000) * (row.pricing_prompt ?? 0) + (tokensOut / 1_000_000) * (row.pricing_completion ?? 0);
  console.log(`run            ${res.reply.trim().slice(0, 60) || "(empty reply)"}`);
  console.log(`ledger row     tokens in=${tokensIn} out=${tokensOut}`);
  console.log(`cost_usd       ${call?.cost_usd ?? "null"}   (expected ${expected})`);

  const checks: Array<[string, boolean]> = [
    ["model is not manifest-covered", !seeded],
    ["discovery found the model", discovery.discovered > 0],
    ["row carries an output rate", row.pricing_completion != null],
    ["ledger row exists with tokens", call != null && tokensIn > 0],
    ["cost_usd is non-null", call?.cost_usd != null],
    ["cost matches the discovered rates", call?.cost_usd != null && Math.abs(call.cost_usd - expected) < 1e-9],
  ];
  console.log("");
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "\nGATE PASS — discovery alone priced the ledger row" : "\nGATE FAIL");
  if (!ok) process.exitCode = 1;
  deps.close();
}

main().catch((e) => {
  const err = e as { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> };
  console.error(`d4 live gate failed: [${err.code ?? "unstructured"}] ${err.message ?? String(e)}`);
  console.error(`  retryable=${err.retryable ?? "?"} details=${JSON.stringify(err.details ?? null)}`);
  process.exitCode = 1;
});
