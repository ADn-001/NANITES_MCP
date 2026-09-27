/**
 * C5 follow-up: plan-gating. `llama-3.2-11b-vision-instruct` returned
 * HTTP 403 with error code 5016 on all three accounts while the other probing
 * models answered fine — so 5016 is not quota (that is 429/4006). The catalog
 * also exposes `require_workers_paid` and `beta` properties, which look like
 * exactly this gating.
 *
 * Reports, for every manifest model: require_workers_paid / beta from the free
 * search endpoint, plus the full error body from one live call to the model
 * that failed, so C6 can classify the code correctly.
 *
 * Run: npx tsx scripts/cf-c5-plan-gating.ts [profile]
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { CLOUDFLARE_AGENT_MANIFEST } from "../src/seed/cloudflareAgentManifest.js";

const BASE = "https://api.cloudflare.com/client/v4";
const FAILED_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

async function main(): Promise<void> {
  const profile = process.argv[2] ?? "test";
  const { db, close } = openNanitesDb();
  const keys = new ProviderKeyStore(db).availableKeys(profile, "cloudflare");
  close();
  const usable = keys.filter((k) => k.account_id);
  const key = usable[0];
  if (!key) {
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

  const props = (m: any, id: string): string => {
    for (const p of Array.isArray(m?.properties) ? m.properties : []) {
      if (p?.property_id === id) return String(p.value);
    }
    return "-";
  };

  console.log("plan-gating properties (free search endpoint, no neurons spent)\n");
  console.log("model_id".padEnd(48) + "paid".padEnd(8) + "beta".padEnd(8) + "realtime".padEnd(10));
  console.log("-".repeat(74));
  for (const seed of CLOUDFLARE_AGENT_MANIFEST) {
    const m = byName.get(seed.model_id);
    if (!m) {
      console.log(`${seed.model_id.padEnd(48)}NOT LISTED`);
      continue;
    }
    console.log(
      seed.model_id.padEnd(48) +
        props(m, "require_workers_paid").padEnd(8) +
        props(m, "beta").padEnd(8) +
        props(m, "realtime").padEnd(10),
    );
  }

  console.log(`\nlive error body for ${FAILED_MODEL}:`);
  for (const k of usable) {
    const r = await fetch(`${BASE}/accounts/${k.account_id}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${k.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: FAILED_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 256,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await r.text();
    console.log(`  [${k.api_key.slice(0, 4)}…${k.api_key.slice(-4)}] http ${r.status} :: ${body.slice(0, 400)}`);
  }
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
});
