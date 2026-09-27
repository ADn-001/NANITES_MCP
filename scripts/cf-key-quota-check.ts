/**
 * Probe each stored Cloudflare key with a minimal request to find one with
 * quota left. Prints masked fingerprints only — never key material.
 *
 * Run: npx tsx scripts/cf-key-quota-check.ts [profile]
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";

const BASE = "https://api.cloudflare.com/client/v4";

async function main(): Promise<void> {
  const profile = process.argv[2] ?? "test";
  const { db, close } = openNanitesDb();
  const keys = new ProviderKeyStore(db).availableKeys(profile, "cloudflare");
  close();

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const fp = `${k.api_key.slice(0, 4)}…${k.api_key.slice(-4)}`;
    const account = k.account_id ?? "(none)";
    if (!k.account_id) {
      console.log(`key[${i}] ${fp} account=${account} -> skipped, no account_id`);
      continue;
    }
    const url = `${BASE}/accounts/${k.account_id}/ai/v1/chat/completions`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${k.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          messages: [{ role: "user", content: "say ok" }],
          max_completion_tokens: 16,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const json: any = await res.json().catch(() => ({}));
      const code = json?.errors?.[0]?.code ?? null;
      const msg = json?.errors?.[0]?.message ?? "";
      const usable = res.status === 200;
      console.log(
        `key[${i}] ${fp} account=${account.slice(0, 6)}… http=${res.status} code=${code ?? "-"} usable=${usable}` +
          (usable ? "" : ` msg=${String(msg).slice(0, 120)}`),
      );
    } catch (e) {
      console.log(`key[${i}] ${fp} account=${account.slice(0, 6)}… TRANSPORT ERROR: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("check failed:", (e as Error).message);
  process.exitCode = 1;
});
