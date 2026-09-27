/**
 * D1 gate helper: report and (optionally) clear the transient key-exhaustion
 * strike on the Cloudflare key. Three consecutive failures retire a key for
 * five minutes (`ProviderKeyStore.recordFailure`); a live probe that hits a
 * provider 5xx can trip that, which then blocks the *next* probe with
 * `all_keys_exhausted` — a confusing failure that has nothing to do with what
 * is being tested. Clears only the strike counter; never prints key material.
 *
 * Run: npx tsx scripts/cf-d1-keycheck.ts [--clear] [profile]
 */
import { buildDeps } from "../src/tools/deps.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";

const clear = process.argv.includes("--clear");
const profileName = process.argv.filter((a) => !a.startsWith("--")).slice(2)[0] ?? "test";

const deps = buildDeps();
const store = new ProviderKeyStore(deps.db);
const keys = store.listKeys(profileName, "cloudflare");
console.log(`profile ${profileName}: ${keys.length} cloudflare key(s)`);
for (const k of keys) {
  console.log(
    `  ${k.key_id.slice(0, 8)} enabled=${k.is_enabled} exhausted=${k.is_exhausted} ` +
      `fails=${k.consecutive_failures} until=${k.exhausted_until ?? "-"}`,
  );
  if (clear && k.is_exhausted) {
    store.clearExhaustion(profileName, "cloudflare", k.key_id);
    console.log("    strike counter cleared");
  }
}
deps.close();
