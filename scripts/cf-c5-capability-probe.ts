/**
 * C5 live questions. Two empirical claims the manifest
 * depends on, answered against the live API rather than assumed:
 *
 *  Q1. Does sending `tools` to a non-function-calling model (`qwq-32b`) return
 *      no tool calls, or does the API reject the request? If it 400s, the
 *      capability gate must be a hard filter; if it silently ignores tools, a
 *      gate is still required but the failure is silent rather than loud.
 *  Q2. Does `/ai/models/search` expose capability/modality fields we could
 *      read instead of maintaining a hand-written manifest?
 *
 * Run: npx tsx scripts/cf-c5-capability-probe.ts [profile]
 * Never prints key material.
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";

const BASE = "https://api.cloudflare.com/client/v4";
const NON_TOOL_MODEL = "@cf/qwen/qwq-32b";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

async function main(): Promise<void> {
  const profile = process.argv[2] ?? "test";
  const { db, close } = openNanitesDb();
  const keys = new ProviderKeyStore(db).availableKeys(profile, "cloudflare");
  close();

  if (keys.length === 0) {
    console.error("no cloudflare key available");
    process.exitCode = 1;
    return;
  }

  const fp = (k: { api_key: string }): string => `${k.api_key.slice(0, 4)}…${k.api_key.slice(-4)}`;

  // ---- Q2: does model search expose capabilities? ------------------------
  // Runs on any key (search is not neuron-metered; it answers 200 even when the
  // account's daily allocation is spent).
  const searchKey = keys.find((k) => k.account_id);
  if (!searchKey?.account_id) {
    console.error("no cloudflare key with account_id");
    process.exitCode = 1;
    return;
  }
  const searchRes = await fetch(`${BASE}/accounts/${searchKey.account_id}/ai/models/search`, {
    headers: { Authorization: `Bearer ${searchKey.api_key}` },
    signal: AbortSignal.timeout(60_000),
  });
  const searchJson: any = await searchRes.json().catch(() => ({}));
  const list: any[] = Array.isArray(searchJson?.result) ? searchJson.result : [];
  console.log(`Q2 /ai/models/search -> http ${searchRes.status}, ${list.length} models (key ${fp(searchKey)})\n`);

  if (list.length > 0) {
    const sample = list.find((m) => String(m?.id ?? "").includes("qwq")) ?? list[0];
    console.log(`  top-level keys: ${Object.keys(sample ?? {}).join(", ")}`);
    const propIds = new Set<string>();
    for (const m of list) {
      for (const p of Array.isArray(m?.properties) ? m.properties : []) {
        if (p?.property_id) propIds.add(String(p.property_id));
      }
    }
    console.log(`  distinct property_ids across all ${list.length} models: ${[...propIds].sort().join(", ")}`);

    for (const target of ["@cf/qwen/qwq-32b", "@cf/meta/llama-3.2-11b-vision-instruct", "@cf/ibm-granite/granite-4.0-h-micro"]) {
      const m = list.find((x) => x?.id === target || x?.name === target);
      if (!m) {
        console.log(`\n  ${target}: NOT LISTED`);
        continue;
      }
      console.log(`\n  ${target}:`);
      console.log(`    task=${m?.task?.name ?? "n/a"}`);
      for (const p of Array.isArray(m?.properties) ? m.properties : []) {
        console.log(`    ${p.property_id} = ${JSON.stringify(p.value).slice(0, 160)}`);
      }
    }
  }

  // ---- Q1: tools sent to a non-tool-capable model ------------------------
  // Rotate keys: 429/4006 means this ACCOUNT's daily neurons are spent, which
  // says nothing about the model. Keep going until one account answers.
  console.log(`\nQ1 tools -> ${NON_TOOL_MODEL}`);
  let answered = false;
  for (const k of keys) {
    if (!k.account_id) continue;
    const url = `${BASE}/accounts/${k.account_id}/ai/v1/chat/completions`;
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${k.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NON_TOOL_MODEL,
        messages: [
          { role: "system", content: "You are a precise reader. Use the read_file tool." },
          { role: "user", content: "Read README.md and tell me the first heading. Use the tool." },
        ],
        tools: TOOLS,
        max_completion_tokens: 8192,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const json: any = await res.json().catch(() => ({}));
    const choice = json?.choices?.[0];
    const msg = choice?.message;
    const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    console.log(`  [${fp(k)}] http ${res.status} | wall ${Date.now() - t0}ms`);
    if (res.status !== 200) {
      console.log(`    error code=${json?.errors?.[0]?.code ?? "n/a"} :: ${String(json?.errors?.[0]?.message ?? "").slice(0, 140)}`);
      continue;
    }
    answered = true;
    console.log(`    tool_calls=${calls.length} | finish_reason=${choice?.finish_reason ?? "n/a"} | content_chars=${typeof msg?.content === "string" ? msg.content.length : 0}`);
    console.log(
      `    verdict: ${
        calls.length > 0
          ? "MODEL CALLED A TOOL — manifest flag may be wrong"
          : "no tool calls returned — tools silently ignored (model chose not to call, or API dropped them)"
      }`,
    );
    if (typeof msg?.content === "string" && msg.content) {
      console.log(`    content[0..200]=${JSON.stringify(msg.content.slice(0, 200))}`);
    }
    break;
  }
  if (!answered) console.log("  all keys exhausted, or every key errored — Q1 unanswered this run");
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
});
