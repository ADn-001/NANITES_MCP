/**
 * C1 experiment. Direct probe of the Cloudflare Workers AI
 * chat-completions endpoint with the raw response printed, bypassing Nanites'
 * parser so we can see ground truth: `finish_reason`, `usage` detail fields,
 * and whether content comes back empty under different token-parameter schemes.
 *
 * Reads the API key from the profile's key store and never prints it.
 *
 * Run: npx tsx scripts/cf-c1-probe.ts [profile] [model]
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { buildCloudChatRequest, planCloudInference } from "../src/providers/cloudPlanner.js";
import type { ChatMessage } from "../src/providers/types.js";

const BASE = "https://api.cloudflare.com/client/v4";

/** A prompt that forces genuine multi-step reasoning before any answer. */
const HARD_BRIEF = `A queue is drained by two concurrent callers. Each iteration
does: check length > 0, shift() one item, await run(item). Under Node's event
loop, enumerate every interleaving that can (a) run an item twice, (b) run
undefined, or (c) drop an item, and for each state which invariant breaks and
what the minimal fix is. Think carefully before answering, then answer with a
structured list.`;

interface Variant {
  label: string;
  model: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

function variants(models: string[]): Variant[] {
  const v: Variant[] = [];
  for (const model of models) {
    v.push({ label: "A baseline max_tokens=4096", model, body: { max_tokens: 4096, temperature: 0.3 } });
    v.push({ label: "B tiny max_tokens=64", model, body: { max_tokens: 64, temperature: 0.3 } });
    v.push({ label: "C tiny max_completion_tokens=64", model, body: { max_completion_tokens: 64, temperature: 0.3 } });
    v.push({ label: "D new: max_completion_tokens=16384", model, body: { max_completion_tokens: 16384, temperature: 0.3 } });
    v.push({ label: "E new: 16384 + reasoning_effort=low", model, body: { max_completion_tokens: 16384, reasoning_effort: "low", temperature: 0.3 } });
    v.push({
      label: "F new: 16384 + chat_template_kwargs.enable_thinking=false",
      model,
      body: { max_completion_tokens: 16384, chat_template_kwargs: { enable_thinking: false }, temperature: 0.3 },
    });
    v.push({
      label: "G D + x-session-affinity header",
      model,
      body: { max_completion_tokens: 16384, temperature: 0.3 },
      headers: { "x-session-affinity": "nanites-c1-probe-session" },
    });
  }
  return v;
}

function summarize(label: string, status: number, json: any, wallMs: number): void {
  const choice = json?.choices?.[0];
  const msg = choice?.message;
  const content: string = typeof msg?.content === "string" ? msg.content : "";
  const reasoningField = msg?.reasoning_content ?? msg?.reasoning ?? null;
  const usage = json?.usage ?? null;
  const truncated = json?.result?.response !== undefined && content === "";

  console.log(`\n=== ${label}`);
  console.log(`  http ${status} | wall ${wallMs}ms | content_chars=${content.length} | finish_reason=${choice?.finish_reason ?? "n/a"}`);
  console.log(`  tool_calls=${msg?.tool_calls?.length ?? 0} | reasoning_field_chars=${reasoningField ? String(reasoningField).length : 0}`);
  if (usage) {
    console.log(`  usage prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
    console.log(`  usage.completion_tokens_details=${JSON.stringify(usage.completion_tokens_details ?? null)}`);
    console.log(`  usage.prompt_tokens_details=${JSON.stringify(usage.prompt_tokens_details ?? null)}`);
  } else {
    console.log("  usage: ABSENT");
  }
  if (truncated) console.log("  note: top-level `result.response` present (legacy /ai/run envelope?)");
  if (content) console.log(`  content[0..160]=${JSON.stringify(content.slice(0, 160))}`);
  if (!content && status !== 200) console.log(`  error body=${JSON.stringify(json).slice(0, 300)}`);
}

async function main(): Promise<void> {
  const profileArg = process.argv[2];
  const modelArgs = process.argv.slice(3).filter((a) => !a.startsWith("--"));

  const { db, close } = openNanitesDb();
  const profile = profileArg ?? "test";
  const store = new ProviderKeyStore(db);
  const keys = store.availableKeys(profile, "cloudflare");

  console.log(`profile=${profile} cloudflare_keys_available=${keys.length}`);
  if (keys.length === 0) {
    console.error("No available Cloudflare key for this profile — aborting.");
    close();
    process.exitCode = 1;
    return;
  }
  const key = keys[0]!;
  if (!key.account_id) {
    console.error(`Key has no account_id — cannot build the endpoint URL. Aborting.`);
    close();
    process.exitCode = 1;
    return;
  }
  console.log(`account_id present=true | key fingerprint=${key.api_key.slice(0, 4)}…${key.api_key.slice(-4)} (masked)`);
  close();

  const url = `${BASE}/accounts/${key.account_id}/ai/v1/chat/completions`;
  const models = modelArgs.length > 0 ? modelArgs : ["@cf/openai/gpt-oss-120b", "@cf/qwen/qwen3-30b-a3b-fp8"];

  const allVariants = process.argv.includes("--prod-only") ? [] : variants(models);

  // Production shape: the body our real code builds, so this proves the fix in
  // src/ rather than a hand-written body. The running MCP server holds pre-fix
  // code until it restarts, so this is the only valid end-to-end check.
  for (const model of models) {
    for (const effort of ["low", "medium"] as const) {
      const plan = planCloudInference(effort, "reviewer");
      const msgs: ChatMessage[] = [{ role: "user", content: HARD_BRIEF }];
      const req = buildCloudChatRequest(plan, "cloudflare", model, msgs, "You are a precise software analyst.");
      allVariants.push({
        label: `PROD planCloudInference(${effort}) budget=${plan.max_output_tokens} reasoning=${plan.reasoning ?? "off"}`,
        model,
        body: req as unknown as Record<string, unknown>,
      });
    }
  }

  for (const v of allVariants) {
    const body = {
      model: v.model,
      messages: [
        { role: "system", content: "You are a precise software analyst." },
        { role: "user", content: HARD_BRIEF },
      ],
      ...v.body,
    };
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          "Content-Type": "application/json",
          ...(v.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const json = await res.json().catch(() => ({ parse_error: true }));
      summarize(`${v.model} :: ${v.label}`, res.status, json, Date.now() - t0);
    } catch (e) {
      console.log(`\n=== ${v.model} :: ${v.label}`);
      console.log(`  TRANSPORT ERROR after ${Date.now() - t0}ms: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
});
