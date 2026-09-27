/**
 * C7: dump per-model Cloudflare pricing for the seeded manifest.
 *
 * The router can only compute `cost_usd` for a model whose row carries pricing.
 * Cloudflare rows were being written with `pricing_prompt`/`pricing_completion`
 * as NULL, so every CF run logged a null cost. The catalog's `price` property
 * has the real numbers; this prints them in manifest shape.
 *
 * Free — the search endpoint costs no neurons.
 *
 * Run: npx tsx scripts/cf-c7-prices.ts [profile]
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { CLOUDFLARE_AGENT_MANIFEST } from "../src/seed/cloudflareAgentManifest.js";

const BASE = "https://api.cloudflare.com/client/v4";

async function main(): Promise<void> {
  const profile = process.argv[2] ?? "test";
  const { db, close } = openNanitesDb();
  const keys = new ProviderKeyStore(db).availableKeys(profile, "cloudflare");
  close();
  const key = keys.find((k) => k.account_id);
  if (!key?.account_id) {
    console.error("no cloudflare key with account_id");
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${BASE}/accounts/${key.account_id}/ai/models/search`, {
    headers: { Authorization: `Bearer ${key.api_key}` },
    signal: AbortSignal.timeout(60_000),
  });
  const json: any = await res.json().catch(() => ({}));
  const list: any[] = Array.isArray(json?.result) ? json.result : [];
  const byName = new Map<string, any>(list.map((m) => [String(m?.name), m]));

  for (const seed of CLOUDFLARE_AGENT_MANIFEST) {
    const m = byName.get(seed.model_id);
    let input: number | null = null;
    let output: number | null = null;
    for (const p of Array.isArray(m?.properties) ? m.properties : []) {
      if (p?.property_id !== "price") continue;
      for (const unit of Array.isArray(p.value) ? p.value : []) {
        if (/input/i.test(String(unit.unit))) input = Number(unit.price);
        if (/output/i.test(String(unit.unit))) output = Number(unit.price);
      }
    }
    console.log(`  pricing_prompt: ${input ?? "null"}, pricing_completion: ${output ?? "null"},  // ${seed.model_id}`);
  }
}

main().catch((e) => {
  console.error("price dump failed:", (e as Error).message);
  process.exitCode = 1;
});
