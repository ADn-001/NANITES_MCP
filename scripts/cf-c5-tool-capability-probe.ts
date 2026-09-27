/**
 * C5: does a model the manifest marks `function_calling:false` actually accept
 * and emit tool calls?
 *
 * The manifest cross-check (`cf-c5-manifest-crosscheck.ts`) showed every
 * `false` flag corresponds to an ABSENT `function_calling` property, and the
 * C5 probe proved qwq-32b returns a real `finish_reason:"tool_calls"` response
 * despite that absence. So absence is "not advertised", not "unsupported".
 *
 * This asks the three FC=false models directly, with a brief that makes a tool
 * call the obvious action. Repeat per model to separate "can" from "happened
 * to". Costs neurons — rotate keys, stop on the first account that answers.
 *
 * Run: npx tsx scripts/cf-c5-tool-capability-probe.ts [profile] [perModel]
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";

const BASE = "https://api.cloudflare.com/client/v4";
const MODELS = [
  "@cf/qwen/qwq-32b",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/meta/llama-3.2-11b-vision-instruct",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the working directory and return its contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to the file." } },
        required: ["path"],
      },
    },
  },
];

const MESSAGES = [
  {
    role: "system",
    content:
      "You are a precise file reader. You must use the read_file tool to read files. " +
      "Never guess a file's contents. Start by reading package.json.",
  },
  { role: "user", content: "Read package.json and tell me the package name." },
];

async function main(): Promise<void> {
  const profile = process.argv[2] ?? "test";
  const perModel = Number(process.argv[3] ?? "2");
  const { db, close } = openNanitesDb();
  const keys = new ProviderKeyStore(db).availableKeys(profile, "cloudflare");
  close();

  const usable = keys.filter((k) => k.account_id);
  if (usable.length === 0) {
    console.error("no cloudflare key with account_id");
    process.exitCode = 1;
    return;
  }

  for (const model of MODELS) {
    console.log(`\n${model}`);
    let answered = 0;
    for (let i = 0; i < perModel; i += 1) {
      let done = false;
      for (const k of usable) {
        const res = await fetch(`${BASE}/accounts/${k.account_id}/ai/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${k.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: MESSAGES,
            tools: TOOLS,
            max_completion_tokens: 16384,
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(240_000),
        });
        const json: any = await res.json().catch(() => ({}));
        if (res.status !== 200) {
          const code = json?.errors?.[0]?.code ?? "n/a";
          console.log(`  attempt ${i + 1}: http ${res.status} code=${code} — next key`);
          continue;
        }
        done = true;
        answered += 1;
        const choice = json?.choices?.[0];
        const msg = choice?.message;
        const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        const names = calls.map((c: any) => c?.function?.name).join(",");
        console.log(
          `  attempt ${i + 1}: tool_calls=${calls.length}${names ? ` (${names})` : ""} | finish_reason=${choice?.finish_reason ?? "n/a"} | content_chars=${typeof msg?.content === "string" ? msg.content.length : 0}`,
        );
        break;
      }
      if (!done) {
        console.log(`  attempt ${i + 1}: every key errored (quota or upstream) — stopping this model`);
        break;
      }
    }
    console.log(`  → ${answered} successful call(s) for ${model}`);
  }
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
});
