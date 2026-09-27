#!/usr/bin/env tsx
/**
 * MCP LOAD_PARALLEL_DEMO — end-to-end proof that Nanites' native load body
 * carries the resolved slot count, seen through both the MCP tool surface
 * (the same path dashboards and harnesses use) and the live Studio API.
 *
 * Steps:
 *   1. Fresh scratch profile (4GB, sequential) -> switch.
 *   2. List models (proves nothing loaded yet).
 *   3. Call MCP `load_model` with profile: "demo" (sequential).
 *   4. List models again — show the live `loaded_instances[0].config.parallel`
 *      straight from Studio, no in-process trust.
 *   5. Cleanup via MCP `unload_model`.
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
const profile = "demo";

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

  const home = mkdtempSync(join(tmpdir(), "nanites-mcp-load-demo-"));
  try {
    const deps = buildDeps(home);
    const server = buildServer({ home, deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "nanites-mcp-load-demo", version: "0.0.1" });
    await server.server.connect(st);
    await mcp.connect(ct);
    const call = async (name: string, args: unknown): Promise<any> => {
      const r = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      return JSON.parse((r.content as any[]).find((c: any) => c.type === "text")?.text ?? "{}");
    };

    console.log("=== 1. Fresh profile (4GB, sequential) ===");
    const r1 = await call("create_profile", { name: profile, endpoint: { url: baseUrl }, machine_specs: { vram_gb: 4 }, inference: { effort: "low" } });
    if (!r1.ok) { console.error("create_profile failed", r1.error); return 1; }
    const r2 = await call("write_registry_entry", { profile, model_id: model, entry: { roles: ["summarizer"] } });
    if (!r2.ok) { console.error("write_registry_entry failed", r2.error); return 1; }
    const r3 = await call("switch_profile", { name: profile });
    if (!r3.ok) { console.error("switch_profile failed", r3.error); return 1; }
    console.log("PASS  profile=sequential 4GB  expected slots=1");

    console.log("\n=== 2. /api/v1/models BEFORE load ===");
    const beforeList = (await lm.listModels()).models.filter((m) => m.loaded_instances.length > 0);
    console.log(`loaded_instances: ${beforeList.length} (expect 0)`);

    console.log("\n=== 3. MCP load_model via tool surface ===");
    const load = await call("load_model", { profile, model_id: model });
    if (!load.ok) { console.error("load_model failed", load.error); return 1; }
    console.log(`PASS  load ok; instance_id=${load.data?.instance_id}`);
    // The Nanites envelope returns the resolved pair in the data; print it so a
    // reviewer can see the value we sent, then corroborate it from Studio.
    console.log(`  resolved num_parallel (Nanites side): ${load.data?.num_parallel ?? load.data?.concurrency?.num_parallel ?? "(not in envelope)"}`);

    console.log("\n=== 4. /api/v1/models AFTER load (live Studio) ===");
    const afterList = (await lm.listModels()).models.filter((m) => m.loaded_instances.length > 0);
    if (afterList.length === 0) { console.error("no loaded instance after load_model"); return 1; }
    const inst = afterList[0].loaded_instances[0];
    console.log(`model:    ${afterList[0].key}`);
    console.log(`instance: ${inst.id}`);
    console.log(`config.parallel (Studio side): ${inst.config?.parallel}`);
    if (inst.config?.parallel === 1) {
      console.log("\nPROOF  Studio config.parallel === 1 — Nanites sequential 4GB profile carried the slot count through the MCP tool surface into the live LM Studio instance.");
    } else {
      console.error(`\nFAIL  expected parallel=1, got ${inst.config?.parallel}`);
      return 1;
    }

    console.log("\n=== 5. Cleanup: MCP unload_model ===");
    const unload = await call("unload_model", { profile, instance_id: inst.id });
    if (!unload.ok) { console.error("unload_model failed", unload.error); }
    const cleared = (await lm.listModels()).models.filter((m) => m.loaded_instances.length > 0);
    console.log(`loaded_instances after unload: ${cleared.length} (expect 0)`);

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
