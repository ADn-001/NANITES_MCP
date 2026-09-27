/**
 * Live compaction over the openai transport. Active profile (test) has
 * ttl_s=45 + a registered qwen3.5-2b summarizer (reasoning_type reasoning).
 * compactSessionContext should skip acquire/teardown and run every map chunk +
 * the reduce over /v1/chat/completions + ttl, logging synthesized stats.
 */
import { buildDeps } from "../dist/tools/deps.js";
import { compactSessionContext } from "../dist/workflows/contextCompactionOrchestrator.js";

const deps = buildDeps();
const prof = deps.profiles.getActiveProfile();
if (!prof) throw new Error("no active profile");
const name = prof.name;
console.log(`profile ${name} ttl_s=${prof.inference?.ttl_s} dynamic=${prof.dynamic_model}`);

const session = [
  { role: "user", content: "Which mountain range separates France and Spain?" },
  { role: "assistant", content: "The Pyrenees form the border between France and Spain." },
  { role: "user", content: "What is the main river of southern France?" },
  { role: "assistant", content: "The Rhone flows through the south of France." },
  { role: "user", content: "And the region that grows lavender?" },
  { role: "assistant", content: "Provence is famous for its lavender fields." },
  { role: "user", content: "Which cheese comes from Normandy?" },
  { role: "assistant", content: "Camembert is the classic Normandy cheese." },
];

const { clientForProfile } = await import("../dist/tools/deps.js");
const client = clientForProfile(prof);
const residentBefore = new Set();
{
  const { models: preModels } = await client.listModels();
  for (const m of preModels) if (m.loaded_instances.length) residentBefore.add(m.key);
}
console.log(`resident before: ${[...residentBefore].join(", ") || "none"}`);

const rows = deps.callLogs.list(name);
const maxIdBefore = Math.max(0, ...rows.map((x) => x.id));
const r = await compactSessionContext(deps, name, session);
const newRows = deps.callLogs.list(name).filter((x) => x.id > maxIdBefore);

console.log(`\nchunk_count=${r.chunk_count} chats_run=${r.chats_run} model=${r.model_id} summary=${JSON.stringify((r.summary ?? "").slice(0, 120))}`);
console.log(`ledger rows written: ${newRows.length}`);
for (const row of newRows) console.log(`  #${row.id} in=${row.tokens_in} out=${row.tokens_out} ttft_ms=${row.ttft_ms} load_ms=${row.load_ms}`);

const { models: postModels } = await client.listModels();
const postKey = (key) => (postModels.find((m) => m.key === key)?.loaded_instances ?? []).map((i) => i.id);
const mPost = postKey(r.model_id);
console.log(`resident ${r.model_id} after: ${mPost.length ? mPost.join(", ") : "none"}  => ${mPost.length ? "warm (openai ttl path, nothing unloaded)" : "evicted"}`);
console.log("compact e2e complete.");
