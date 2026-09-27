#!/usr/bin/env tsx
/**
 * SHOW LOADED INSTANCE — proves the Studio v1 instance.config.parallel field
 * after a Nanites load carries the resolved profile pair (default 1 on a
 * sequential tier, 2 on a 16GB parallel tier). Blocks the call until the
 * instance shows up in /api/v1/models, then prints the raw entry.
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
const profile = process.env.LIVE_PROFILE_NAME ?? "demo-seq";
const vram = Number(process.env.LIVE_PROFILE_VRAM ?? "4");

async function main(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "nanites-show-loaded-"));
  try {
    const deps = buildDeps(home);
    const server = buildServer({ home, deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "nanites-show-loaded", version: "0.0.1" });
    await server.server.connect(st);
    await mcp.connect(ct);
    const call = async (name: string, args: unknown): Promise<any> => {
      const r = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      return JSON.parse((r.content as any[]).find((c: any) => c.type === "text")?.text ?? "{}");
    };

    await call("create_profile", { name: profile, endpoint: { url: baseUrl }, machine_specs: { vram_gb: vram }, inference: { effort: "low" } });
    await call("write_registry_entry", { profile, model_id: model, entry: { roles: ["summarizer"] } });
    await call("switch_profile", { name: profile });

    const chatPromise = call("run_sub_agent", { profile, model_id: model, brief: "List 1..3 slowly.", effort: "low" });
    const lm = new LmStudioClient({ baseUrl, timeoutMs: 10_000 });
    const deadline = Date.now() + 30_000;
    let snapshot: { data?: Array<{ loaded_instances: Array<Record<string, unknown>>; key: string }> } | null = null;
    while (Date.now() < deadline) {
      const r = await lm.listModels();
      const found = r.data?.find?.((m) => m.loaded_instances.length > 0) ?? null;
      // listModels may return a wrapper, normalize
      const anyModels: any[] = (r as any).models ?? (r as any).data ?? [];
      const hit = anyModels.find((m) => m.loaded_instances.length > 0);
      if (hit) { snapshot = { data: anyModels }; break; }
      await new Promise((res) => setTimeout(res, 100));
    }
    await chatPromise;

    if (!snapshot) {
      console.error("no instance observed mid-flight");
      return 1;
    }
    const inst = snapshot.data!.find((m) => m.loaded_instances.length > 0)!;
    const live = inst.loaded_instances[0];
    console.log("=== Studio v1 /api/v1/models — loaded instance ===");
    console.log(`model:    ${inst.key}`);
    console.log(JSON.stringify(live, null, 2));

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
