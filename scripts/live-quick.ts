#!/usr/bin/env tsx
/**
 * LIVE QUICK — minimal sub-agent smoke against real LM Studio. Creates a
 * scratch profile, binds qwen3.5-0.8b to the summarizer role, switches, runs
 * one sub-agent call, prints elapsed time + reply + token usage.
 *
 * Usage:
 *   NANITES_LM_BASE_URL=http://127.0.0.1:1234 \
 *     LIVE_MODEL=qwen3.5-0.8b tsx scripts/live-quick.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server/buildServer.js";
import { buildDeps } from "../src/tools/deps.js";
import { NanitesError } from "../src/helpers/errors.js";
import { LmStudioClient } from "../src/lmstudio/client.js";

const baseUrl = process.env.NANITES_LM_BASE_URL ?? "http://127.0.0.1:1234";
const model = process.env.LIVE_MODEL ?? "qwen3.5-0.8b";

async function main(): Promise<number> {
  const probe = new LmStudioClient({ baseUrl, timeoutMs: 10_000 });
  try {
    await probe.listModels();
  } catch (err) {
    if (err instanceof NanitesError) {
      console.log(`SKIP: ${err.code} (${err.message})`);
      return 0;
    }
    throw err;
  }
  console.log(`OK  LM Studio reachable at ${baseUrl}; using model "${model}"`);

  const home = mkdtempSync(join(tmpdir(), "nanites-live-quick-"));
  try {
    const deps = buildDeps(home);
    const server = buildServer({ home, deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "nanites-live-quick", version: "0.0.1" });
    await server.server.connect(st);
    await mcp.connect(ct);
    const call = async (name: string, args: unknown): Promise<{ ok: boolean; data?: any; error?: any }> => {
      const r = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      const text = (r.content.find((c: any) => c.type === "text")?.text ?? "{}") as string;
      return JSON.parse(text);
    };

    const r1 = await call("create_profile", {
      name: "quick",
      endpoint: { url: baseUrl },
      machine_specs: { vram_gb: 4 },
      inference: { effort: "low" },
    });
    if (!r1.ok) { console.error("create_profile failed", r1.error); return 1; }
    console.log("PASS  create_profile");

    const r2 = await call("write_registry_entry", { profile: "quick", model_id: model, entry: { roles: ["summarizer"] } });
    if (!r2.ok) { console.error("write_registry_entry failed", r2.error); return 1; }
    console.log("PASS  write_registry_entry");

    const r3 = await call("switch_profile", { name: "quick" });
    if (!r3.ok) { console.error("switch_profile failed", r3.error); return 1; }
    console.log("PASS  switch_profile");

    const start = Date.now();
    const r4 = await call("run_sub_agent", {
      profile: "quick",
      model_id: model,
      brief: "Name one planet in exactly one short sentence.",
      effort: "low",
    });
    const elapsed = Date.now() - start;
    if (!r4.ok) { console.error("run_sub_agent failed", r4.error); return 1; }
    console.log(`PASS  run_sub_agent (${elapsed}ms)`);
    console.log(`  reply: ${JSON.stringify(r4.data?.reply)}`);
    console.log(`  loaded_this_call: ${r4.data?.loaded_this_call}`);
    if (r4.data?.usage) console.log(`  usage: ${JSON.stringify(r4.data.usage)}`);

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
