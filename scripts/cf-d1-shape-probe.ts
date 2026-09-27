/**
 * D1 wire experiment: which `response_format` shape does Cloudflare's
 * OpenAI-compatible endpoint actually accept?
 *
 * The specialist answer that shaped D1 says the flat shape
 * (`{type:"json_schema", schema}`). Sent live, it returns HTTP 500 with
 * provider code `3043`, reproducibly, while the identical call *without*
 * `response_format` succeeds — so the field, not the model, is being rejected.
 * This script tries the candidate shapes against the same tiny prompt and
 * prints the outcome of each, so the serializer is corrected against evidence
 * instead of a second guess.
 *
 * Live credentials come from the profile's key store and are used in-process
 * only; no key material is printed or written.
 *
 * Run: npx tsx scripts/cf-d1-shape-probe.ts [profile]
 */
import { buildDeps } from "../src/tools/deps.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { createProviderClient } from "../src/providers/client.js";
import type { ChatRequest } from "../src/providers/types.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";

const SCHEMA = {
  type: "object",
  properties: { defect: { type: "string" }, severity: { type: "string", enum: ["low", "high"] } },
  required: ["defect", "severity"],
};

const SHAPES: Array<{ name: string; wire: Record<string, unknown> }> = [
  { name: "flat", wire: { type: "json_schema", schema: SCHEMA } },
  { name: "nested", wire: { type: "json_schema", json_schema: { name: "probe", schema: SCHEMA } } },
  { name: "nested+strict", wire: { type: "json_schema", json_schema: { name: "probe", schema: SCHEMA, strict: true } } },
  { name: "json_object", wire: { type: "json_object" } },
];

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "test";
  const deps = buildDeps();
  const keys = new ProviderKeyStore(deps.db).availableKeys(profileName, "cloudflare");
  if (keys.length === 0) {
    console.error(`no available cloudflare key on profile ${profileName}`);
    process.exitCode = 1;
    return;
  }
  const key = keys[0]!;
  const client = createProviderClient("cloudflare");
  console.log(`${keys.length} key(s) available | starting with ${key.key_id.slice(0, 8)}\n`);

  // A key that has spent its daily allowance (4006) says nothing about the
  // shape under test, so walk to the next account instead of reporting a
  // misleading failure. The first key that answers anything else is kept.
  let working: (typeof keys)[number] | null = null;
  for (const shape of SHAPES) {
    const ordered = working ? [working, ...keys.filter((k) => k.key_id !== working!.key_id)] : keys;
    const req: ChatRequest = {
      model: MODEL,
      messages: [
        { role: "system", content: "Answer with JSON only." },
        { role: "user", content: 'Report one defect: "unused import", severity "low".' },
      ],
      max_completion_tokens: 256,
      temperature: 0.3,
      response_format: shape.wire,
    };
    for (const candidate of ordered) {
      try {
        const res = await client.chat(req, candidate.api_key, candidate.account_id ?? undefined);
        working = candidate;
        const content = (res.content ?? "").trim();
        console.log(`PASS  ${shape.name.padEnd(14)} key=${candidate.key_id.slice(0, 8)} finish=${res.finish_reason ?? "?"} chars=${content.length}`);
        console.log(`      ${content.slice(0, 160).replace(/\n/g, " ")}`);
        break;
      } catch (err) {
        const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
        if (e.code === "provider_quota_exhausted") {
          console.log(`skip  ${shape.name.padEnd(14)} key=${candidate.key_id.slice(0, 8)} daily allowance spent`);
          continue;
        }
        console.log(`FAIL  ${shape.name.padEnd(14)} key=${candidate.key_id.slice(0, 8)} [${e.code ?? "?"}] ${e.message ?? String(err)}`);
        console.log(`      details=${JSON.stringify(e.details ?? null)}`);
        break;
      }
    }
  }
  deps.close();
}

main().catch((e) => {
  console.error(`shape probe crashed: ${(e as Error).message}`);
  process.exitCode = 1;
});
