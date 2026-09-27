/**
 * C5: cross-check the hand-written manifest against live `/ai/models/search`.
 *
 * The Phase 0 probe concluded CF discovery returns "no capability/modality
 * data". The C5 probe found that wrong for the search endpoint: each model
 * carries a `properties` array with `function_calling`, `vision`, `reasoning`,
 * `context_window`, `max_input_tokens`, `price`, `beta`, `realtime`, ...
 *
 * This compares the manifest's flags to those properties for every seeded
 * model. Search costs no neurons, so this is free and safe to re-run.
 *
 * CAVEAT the C5 probe established: a property can be ABSENT while the model
 * still supports it (qwq-32b has no `function_calling` property yet returned a
 * real tool call). Absence is therefore "not advertised", not "unsupported" —
 * never let this script's output flip a flag to false on absence alone.
 *
 * Run: npx tsx scripts/cf-c5-manifest-crosscheck.ts [profile]
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { CLOUDFLARE_AGENT_MANIFEST } from "../src/seed/cloudflareAgentManifest.js";

const BASE = "https://api.cloudflare.com/client/v4";

function propMap(m: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of Array.isArray(m?.properties) ? m.properties : []) {
    if (p?.property_id) out[String(p.property_id)] = p.value;
  }
  return out;
}

function flag(v: unknown): string {
  if (v === undefined) return "absent";
  return String(v) === "true" ? "true" : String(v);
}

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
  // `id` is a UUID; the `@cf/...` runnable id lives in `name`.
  const byId = new Map<string, any>();
  for (const m of list) {
    if (m?.name) byId.set(String(m.name), m);
    if (m?.id) byId.set(String(m.id), m);
  }
  console.log(`live catalog: ${list.length} models | manifest: ${CLOUDFLARE_AGENT_MANIFEST.length}\n`);

  const header = "model_id".padEnd(48) + "fc(man/live)".padEnd(14) + "vision(man/live)".padEnd(18) + "reasoning(man/live)".padEnd(20) + "ctx(man/live)";
  console.log(header);
  console.log("-".repeat(header.length));

  const mismatches: string[] = [];
  for (const seed of CLOUDFLARE_AGENT_MANIFEST) {
    const m = byId.get(seed.model_id);
    if (!m) {
      console.log(`${seed.model_id.padEnd(48)}NOT IN LIVE CATALOG`);
      mismatches.push(`${seed.model_id}: not in live catalog`);
      continue;
    }
    const p = propMap(m);
    const liveCtx = p.context_window !== undefined ? String(p.context_window) : "absent";
    const row =
      seed.model_id.padEnd(48) +
      `${seed.function_calling ? "T" : "F"}/${flag(p.function_calling)}`.padEnd(14) +
      `${seed.vision ? "T" : "F"}/${flag(p.vision)}`.padEnd(18) +
      `${seed.reasoning ? "T" : "F"}/${flag(p.reasoning)}`.padEnd(20) +
      `${seed.context_length}/${liveCtx}`;
    console.log(row);
    if (p.function_calling !== undefined && (String(p.function_calling) === "true") !== seed.function_calling) {
      mismatches.push(`${seed.model_id}: function_calling manifest=${seed.function_calling} live=${p.function_calling}`);
    }
    if (p.vision !== undefined && (String(p.vision) === "true") !== seed.vision) {
      mismatches.push(`${seed.model_id}: vision manifest=${seed.vision} live=${p.vision}`);
    }
    if (p.reasoning !== undefined && (String(p.reasoning) === "true") !== seed.reasoning) {
      mismatches.push(`${seed.model_id}: reasoning manifest=${seed.reasoning} live=${p.reasoning}`);
    }
    if (p.context_window !== undefined && Number(p.context_window) !== seed.context_length) {
      mismatches.push(`${seed.model_id}: context_length manifest=${seed.context_length} live=${p.context_window}`);
    }
  }

  console.log(`\ncontradictions where the live API ADVERTISES a differing value (absence excluded):`);
  if (mismatches.length === 0) console.log("  none");
  for (const mm of mismatches) console.log(`  - ${mm}`);
}

main().catch((e) => {
  console.error("crosscheck failed:", (e as Error).message);
  process.exitCode = 1;
});
