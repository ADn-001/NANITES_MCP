/**
 * Phase T live probe — per-request ttl over /v1/chat/completions on the real
 * LM Studio. Answers:
 *   P1: ttl honored — a ttl:15 request leaves the model loaded, then auto-evicts
 *       within ~20s (listModels shows 0 resident instances of the key).
 *   P2: no orphan growth — N sequential same-key ttl:8 requests leave exactly
 *       ONE resident instance of that key, not a family of JIT siblings.
 *   P3: wire shape — `data: [DONE]`, `\n\n` delimiters, finish_reason, and
 *       whether reasoning_content deltas appear when reasoning flags are sent.
 *
 * Mutates the real server only by requesting load + letting ttl auto-evict.
 * Run:  node scripts/ttl-live-probe.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const home = process.env.NANITES_HOME || path.join(homedir(), ".nanites");
const profilePath = path.join(home, "profiles", "test.json");
if (!existsSync(profilePath)) throw new Error(`no profile at ${profilePath}`);
const prof = JSON.parse(readFileSync(profilePath, "utf8"));
const base = prof.endpoint.url;
const token = prof.endpoint?.auth_token ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getModels() {
  const res = await fetch(`${base}/api/v1/models`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()).models ?? [];
}

function instancesOf(models, key) {
  const m = models.find((x) => x.key === key);
  return (m?.loaded_instances ?? []).map((i) => i.id);
}

async function openAiChat(model, extra = {}) {
  const body = { model, messages: [{ role: "user", content: "Reply exactly with the single word: ok" }], max_tokens: 64, stream: true, ...extra };
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const blocks = text.split("\n\n").filter(Boolean);
  const dataLines = blocks.filter((b) => b.startsWith("data:")).map((b) => b.slice(5).trim());
  const chunks = [];
  const deltas = [];
  let sawDone = false;
  for (const dl of dataLines) {
    if (dl === "[DONE]") { sawDone = true; continue; }
    try {
      const chunk = JSON.parse(dl);
      chunks.push(chunk);
      const d = chunk.choices?.[0]?.delta ?? {};
      deltas.push(d);
    } catch {
      /* non-JSON keepalive */
    }
  }
  const reply = deltas.filter((d) => typeof d.content === "string").map((d) => d.content).join("");
  const last = chunks[chunks.length - 1];
  return { reply, sawDone, chunkKeys: new Set(chunks.flatMap((c) => Object.keys(c))), deltaKeys: new Set(deltas.flatMap((c) => Object.keys(c))), finishReason: chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).join(","), usage: last?.usage ?? null, ms: Date.now() - started };
}

async function main() {
  console.log(`\n== ttl live probe @ ${base} ==\n`);

  const A = "qwen3.5-0.8b";
  const B = "qwen3.5-2b";

  // P3 first — wire shape on a small known-reasoning-capable model, ttl:0 so no
  // lifecycle side effects for this read.
  console.log("-- P3 wire shape (qwen3.5-0.8b, reasoning low) --");
  const p3 = await openAiChat(A, { ttl: 0, reasoning: "low", reasoning_budget: 200 });
  console.log(`  status: reply=${JSON.stringify(p3.reply.slice(0, 60))} sawDone=${p3.sawDone} finish_reason=${p3.finishReason}`);
  console.log(`  top chunk keys: ${[...p3.chunkKeys].join(", ")}`);
  console.log(`  delta keys seen: ${[...p3.deltaKeys].join(", ")} (reasoning_content present => ${p3.deltaKeys.has("reasoning_content")})`);
  console.log(`  usage: ${JSON.stringify(p3.usage)} (${p3.ms}ms)`);

  // P1 — ttl honored + auto-evict.
  console.log("\n-- P1 ttl honored (qwen3.5-2b, ttl 15) --");
  const before = instancesOf(await getModels(), B);
  console.log(`  resident before: ${before.length ? before.join(", ") : "none"}`);
  const p1 = await openAiChat(B, { ttl: 15 });
  const mid = instancesOf(await getModels(), B);
  console.log(`  reply=${JSON.stringify(p1.reply.slice(0, 60))} resident mid (loaded, ttl:15): ${mid.length ? mid.join(", ") : "NONE?"}`);
  console.log(`  waiting 20s for auto-evict...`);
  await sleep(20_000);
  const after = instancesOf(await getModels(), B);
  console.log(`  resident after 20s: ${after.length ? after.join(", ") : "none"}  => ${after.length === 0 ? "AUTO-EVICTED (ttl honored)" : "STILL RESIDENT"}`);

  // P2 — sequential same-key burst leaves one instance.
  console.log("\n-- P2 no orphan growth (qwen3.5-0.8b, ttl 8 x3 sequential) --");
  for (let i = 1; i <= 3; i++) {
    const r = await openAiChat(A, { ttl: 8 });
    const now = instancesOf(await getModels(), A);
    console.log(`  req ${i}: reply=${JSON.stringify(r.reply.slice(0, 40))} resident=${now.length ? now.join(", ") : "none"}`);
  }
  const burst = instancesOf(await getModels(), A);
  console.log(`  after burst: ${burst.length} resident instance(s): ${burst.join(", ") || "none"}`);

  // P3b — content deltas flow when the model is not starved by reasoning. Two
  // shapes: reasoning off (direct content) and reasoning low w/ a small budget
  // (reasoning_content deltas THEN content deltas in one stream).
  console.log("\n-- P3b content-producing streams (qwen3.5-2b) --");
  const p3bOff = await openAiChat(B, { ttl: 0, reasoning: "off", max_tokens: 300 });
  console.log(`  reasoning off: reply=${JSON.stringify(p3bOff.reply.slice(0, 80))} sawDone=${p3bOff.sawDone} finish_reason=${p3bOff.finishReason}`);
  console.log(`    delta keys: ${[...p3bOff.deltaKeys].join(", ")} usage=${JSON.stringify(p3bOff.usage)}`);
  const p3bOn = await openAiChat(B, { ttl: 0, reasoning: "low", reasoning_budget: 64, max_tokens: 300 });
  console.log(`  reasoning low (budget 64): reply=${JSON.stringify(p3bOn.reply.slice(0, 80))} finish_reason=${p3bOn.finishReason}`);
  console.log(`    delta keys: ${[...p3bOn.deltaKeys].join(", ")} reasoning_present=${p3bOn.deltaKeys.has("reasoning_content")} usage=${JSON.stringify(p3bOn.usage)}`);

  // P4 — informational: does sending a context_length over /v1 force a reload
  // of an already-resident key? Compare the resident instance id before/after a
  // request that raises context_length. Unchanged id = applied without reload.
  console.log("\n-- P4 context_length over /v1 (informational) --");
  await openAiChat(A, { ttl: 60, reasoning: "off", max_tokens: 200, context_length: 4096 });
  const id0 = instancesOf(await getModels(), A)[0];
  console.log(`  resident after context_length 4096 request: ${id0 ?? "none"}`);
  await openAiChat(A, { ttl: 60, reasoning: "off", max_tokens: 200, context_length: 8192 });
  const id1 = instancesOf(await getModels(), A)[0];
  console.log(`  resident after context_length 8192 request: ${id1 ?? "none"}  => ${id0 === id1 ? "SAME instance (no forced reload)" : "instance changed (context bump forced reload)"}`);

  console.log("\nprobe complete.\n");
}

main().catch((err) => {
  console.error("probe failed:", err.message);
  process.exit(1);
});
