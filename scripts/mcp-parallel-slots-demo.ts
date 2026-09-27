#!/usr/bin/env tsx
/**
 * MCP PARALLEL SLOTS DEMO — switch to a 16GB parallel profile (2x2), run a
 * real sub-agent task end-to-end, and read back the live Studio instance to
 * prove the load body actually carried parallel: 2 (NOT the 1 we saw on the
 * 4GB sequential profile, NOT the 4 Studio would default to).
 *
 * The test uses ONLY the MCP tool surface (create_profile, write_registry,
 * switch_profile, run_sub_agent) — the same paths dashboards and harnesses
 * use — so the result is what a user would see, not what a direct Studio
 * curl would show.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server/buildServer.js";
import { buildDeps } from "../src/tools/deps.js";
import { LmStudioClient } from "../src/lmstudio/client.js";

const baseUrl = process.env.NANITES_LM_BASE_URL ?? "http://127.0.0.1:1234";
const model = process.env.LIVE_MODEL ?? "qwen3.5-0.8b";
const profile = "par16";

async function main(): Promise<number> {
  const lm = new LmStudioClient({ baseUrl, timeoutMs: 10_000 });
  // Make sure no stale instance from a previous run skews the snapshot.
  try {
    const before = await lm.listModels();
    for (const m of before.models) {
      for (const inst of m.loaded_instances) {
        try { await lm.unloadModel({ instance_id: inst.id }); } catch {}
      }
    }
  } catch {}

  const home = mkdtempSync(join(tmpdir(), "nanites-mcp-par-slots-"));
  try {
    const deps = buildDeps(home);
    const server = buildServer({ home, deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "nanites-mcp-par-slots", version: "0.0.1" });
    await server.server.connect(st);
    await mcp.connect(ct);
    const call = async (name: string, args: unknown): Promise<any> => {
      const r = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      return JSON.parse((r.content as any[]).find((c: any) => c.type === "text")?.text ?? "{}");
    };

    console.log("=== 1. Fresh 16GB parallel profile (expected pair 2x2) ===");
    const r1 = await call("create_profile", { name: profile, endpoint: { url: baseUrl }, machine_specs: { vram_gb: 16 }, inference: { effort: "low" } });
    if (!r1.ok) { console.error("create_profile failed", r1.error); return 1; }
    const r2 = await call("write_registry_entry", { profile, model_id: model, entry: { roles: ["summarizer"] } });
    if (!r2.ok) { console.error("write_registry_entry failed", r2.error); return 1; }
    const r3 = await call("switch_profile", { name: profile });
    if (!r3.ok) { console.error("switch_profile failed", r3.error); return 1; }
    console.log("PASS  profile=parallel 16GB  expected num_parallel=2");

    console.log("\n=== 2. Confirm resolved pair via get_active_profile ===");
    const prof = await call("get_active_profile", {});
    const profObj: any = (prof as any).data ?? (prof as any).profile ?? prof;
    const pConc = profObj?.concurrency ?? profObj?.profile?.concurrency;
    console.log(`  name:                ${profObj?.name ?? profObj?.profile?.name}`);
    console.log(`  num_parallel:        ${pConc?.num_parallel}`);
    console.log(`  max_parallel_models: ${pConc?.max_parallel_models}`);
    console.log(`  mode:                ${pConc?.mode}`);

    console.log("\n=== 3. MCP run_sub_agent — simple task (poll Studio while it runs) ===");
    // Sub-agent auto-unloads on teardown, so a single listModels after the
    // call returns will usually see the slot already freed. Poll until the
    // instance shows up, then await the call result.
    const r4Promise = call("run_sub_agent", {
      profile,
      model_id: model,
      brief: "Reply with one short sentence naming a planet.",
      effort: "low",
    });
    let inst: { id: string; config?: { parallel?: number; context_length?: number } } | null = null;
    const pollDeadline = Date.now() + 30_000;
    while (Date.now() < pollDeadline) {
      const r = (await lm.listModels()).models;
      const hit = r.find((m) => m.loaded_instances.length > 0);
      if (hit) { inst = hit.loaded_instances[0]; break; }
      await new Promise((res) => setTimeout(res, 80));
    }
    const t0 = Date.now();
    const r4 = await r4Promise;
    const elapsed = Date.now() - t0;
    if (!r4.ok) { console.error("run_sub_agent failed", r4.error); return 1; }
    console.log(`PASS  run_sub_agent (${elapsed}ms)`);
    console.log(`  reply: ${JSON.stringify(r4.data?.reply)}`);
    console.log(`  loaded_this_call: ${r4.data?.loaded_this_call}`);

    console.log("\n=== 4. Live Studio /api/v1/models (captured mid-flight) ===");
    if (!inst) { console.error("no instance observed mid-flight"); return 1; }
    console.log(`  instance_id:          ${inst.id}`);
    console.log(`  config.parallel:      ${inst.config?.parallel}`);
    console.log(`  config.context_length: ${inst.config?.context_length}`);
    if (inst.config?.parallel === 2) {
      console.log("\nPROOF  Studio config.parallel === 2 — Nanites 16GB parallel profile carried 2 slots through the MCP run_sub_agent path into the live LM Studio instance.");
    } else {
      console.error(`\nFAIL  expected parallel=2, got ${inst.config?.parallel}`);
      return 1;
    }

    console.log("\n=== 5. Cleanup via MCP unload_model ===");
    const unload = await call("unload_model", { profile, instance_id: inst.id });
    if (!unload.ok) { console.error("unload_model failed", unload.error); }
    const cleared = (await lm.listModels()).models.filter((m) => m.loaded_instances.length > 0);
    console.log(`  loaded_instances after unload: ${cleared.length} (expect 0)`);

    await mcp.close();
    await server.server.close();
    deps.close();
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
  return 0;
}

void main().then((code) => process.exit(code)).catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
