/**
 * Live Phase-T E2E on the active profile: set inference.ttl_s, then run a real
 * sub-agent over /v1/chat/completions + ttl and print the transport evidence —
 * metrics.load_ms null / instance_id empty / unloaded false on the openai path,
 * plus a nonzero synthesized token/ttft row in the call ledger (requires the
 * include_usage stream fix). Run from repo root after `npm run build`.
 */
import { buildDeps } from "../dist/tools/deps.js";

const deps = buildDeps();
const prof = deps.profiles.getActiveProfile();
if (!prof) throw new Error("no active profile — switch to TEST first");
const name = prof.name;

console.log(`active profile: ${name} (dynamic_model=${prof.dynamic_model}, ttl_s=${prof.inference?.ttl_s ?? 0})`);

// Patch ttl_s on (profile already has inference merged by updateProfile).
const TTL = 45;
const patched = deps.profiles.updateProfile(name, { inference: { ttl_s: TTL } });
console.log(`patched ttl_s -> ${patched.inference?.ttl_s} (effort preserved: ${patched.inference?.effort})`);

// qwen3.5-2b is a reasoning model. With reasoning_type "reasoning" the planner
// sends reasoning "on" + a budget (deterministic content); treated as
// non_reasoning it sends reasoning "off", which this endpoint ignores and the
// model then thinks through the whole ceiling (observed empty replies live).
const existing = deps.registry.get(name, "qwen3.5-2b");
if (existing?.reasoning_type !== "reasoning") {
  deps.registry.upsert(name, {
    model_id: "qwen3.5-2b",
    roles: existing?.roles ?? ["summarizer"],
    scores: existing?.scores ?? {},
    best_params: existing?.best_params ?? {},
    performance_score: existing?.performance_score ?? 50,
    reasoning_type: "reasoning",
  });
}

const { runSubAgent } = await import("../dist/workflows/runSubAgent.js");

const brief = "Count the letters in the word 'nanites' and reply with just the number, nothing else.";
const r = await runSubAgent(deps, name, brief, {
  roles: ["summarizer"],
  model_id: "qwen3.5-2b",
  effort: "medium",
  reasoning_budget: 64,
});

// openai path: no acquire -> instance_id "" + load_ms null + nothing unloaded.
// loaded_this_call is NOT set on the result object for the openai branch (only
// in the emitted model_load.end payload), so it can't distinguish transport here.
const transport = r.instance_id === "" && !r.unloaded && r.metrics.load_ms === 0 ? "openai (/v1+ttl)" : "native";
console.log("\n-- sub-agent result --");
console.log(`  role=${r.role} model=${r.model_id}`);
console.log(`  transport evidence: instance_id=${JSON.stringify(r.instance_id)} loaded_this_call=${r.loaded_this_call} unloaded=${r.unloaded} load_ms=${r.metrics.load_ms} => ${transport}`);
console.log(`  reply=${JSON.stringify(r.reply.slice(0, 120))}`);
console.log(`  validation.cleaned=${r.validation.cleaned} issues=${JSON.stringify(r.validation.issues)}`);
console.log(`  token_usage=${JSON.stringify(r.token_usage)}`);
console.log(`  stats ttft_ms=${r.metrics.ttft_ms} t_s=${r.metrics.t_s} infer_ms=${r.metrics.infer_ms}`);
console.log(`  call_log_id=${r.call_log_id} perf_score=${r.performance_score} tools_used=${r.tools_used.length}`);

// Ledger row should carry real (nonzero) tokens + ttft — proof the synthesized
// usage survived the wire.
const row = deps.callLogs.list(name).find((x) => x.id === r.call_log_id);
console.log(`  ledger row: tokens_in=${row?.tokens_in} tokens_out=${row?.tokens_out} ttft_ms=${row?.ttft_ms} load_ms=${row?.load_ms} cost_usd=${row?.cost_usd}`);

// Resident check: on a ttl-eligible path nothing was unloaded; qwen3.5-2b should
// still be resident (warm, auto-evict after ttl).
const { clientForProfile } = await import("../dist/tools/deps.js");
const client = clientForProfile(patched);
const { models } = await client.listModels();
const insts = models.find((m) => m.key === "qwen3.5-2b")?.loaded_instances ?? [];
console.log(`  resident qwen3.5-2b after run: ${insts.length ? insts.map((i) => i.id).join(", ") : "none (evicted?)"}`);

// Restore ttl_s off? No — leave ON (that was the point); the profile now routes
// tool-less sub-agents over ttl by default.
console.log("\ne2e complete.");
