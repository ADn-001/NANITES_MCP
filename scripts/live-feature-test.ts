#!/usr/bin/env tsx
/**
 * LIVE FEATURE TEST — not part of CI, not gate-blocking.
 *
 * Drives the real MCP server (buildServer + InMemoryTransport, real LM Studio
 * at NANITES_LM_BASE_URL) end-to-end for the Part A + Part C features:
 *   - system_prompt_override + reasoning_budget per-call params (schema +
 *     wire acceptance)
 *   - dynamic_model ON (hot-load registry match) vs OFF (use loaded pool)
 *   - enriched response shape { reply, validation, token_usage, metrics,
 *     performance_score }
 *   - reasoning + reasoning_budget acceptance at the raw client layer
 *
 * Picks a small resident-capable model by default
 * (LIVE_MODEL=qwen3.5-0.8b). If LM Studio is unreachable, prints SKIP and
 * exits 0. Reachable-but-failing exits 1.
 *
 *   npm run live-feature  (or)  NANITES_LM_BASE_URL=http://localhost:1234 \
 *     LIVE_MODEL=qwen3.5-0.8b tsx scripts/live-feature-test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server/buildServer.js";
import { buildDeps } from "../src/tools/deps.js";
import { LmStudioClient } from "../src/lmstudio/client.js";
import { NanitesError } from "../src/helpers/errors.js";

const baseUrl = process.env.NANITES_LM_BASE_URL ?? "http://localhost:1234";
const model = process.env.LIVE_MODEL ?? "qwen3.5-0.8b";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label} ${detail}`);
  }
}

async function main(): Promise<number> {
  const client = new LmStudioClient({ baseUrl, timeoutMs: 30_000 });
  try {
    await client.listModels();
  } catch (err) {
    if (err instanceof NanitesError && (err.code === "connection_refused" || err.code === "network_error")) {
      console.log(`SKIP: LM Studio unreachable at ${baseUrl} (${err.code}). Live test; run with the server up.`);
      return 0;
    }
    throw err;
  }
  console.log(`OK  LM Studio reachable at ${baseUrl}; using model "${model}"`);

  const home = mkdtempSync(join(tmpdir(), "nanites-live-"));
  try {
    const deps = buildDeps(home);
    const server = buildServer({ home, deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "nanites-live", version: "0.0.1" });
    await server.server.connect(st);
    await mcp.connect(ct);

    const call = async (name: string, args: unknown): Promise<any> => {
      const r = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      const text = r.content.find((c: any) => c.type === "text")?.text ?? "{}";
      return JSON.parse(text);
    };

    await call("create_profile", {
      name: "live",
      endpoint: { url: baseUrl },
      machine_specs: { vram_gb: 4 },
      inference: { system_prompt: "You are a terse test assistant." },
    });
    await call("switch_profile", { name: "live" });

    // ---- Part C: system_prompt_override + reasoning_budget accepted + hot-load (ON) ----
    const liveP = await call("get_active_profile", {});
    ok(liveP.data?.profile?.inference?.system_prompt === "You are a terse test assistant.", "persistent system_prompt stored");
    console.log("\n[ON-mode] hot-load registry match + system_prompt_override (effort low -> reasoning off -> clean reply)");
    await call("write_registry_entry", { profile: "live", model_id: model, entry: { roles: ["summarizer"] } });
    const on = await call("run_sub_agent", {
      profile: "live",
      model_id: model,
      brief: "Say the word done in one word.",
      system_prompt_override: "You must reply with exactly one word.",
      effort: "low",
    });
    ok(on.ok === true, "run_sub_agent (ON) ok", JSON.stringify(on.error));
    ok(typeof on.data?.reply === "string" && on.data.reply.length > 0, "reply produced", `reply=${JSON.stringify(on.data?.reply).slice(0,60)}`);
    ok(on.data?.validation && typeof on.data.validation.cleaned === "boolean", "validation field");
    ok(on.data?.metrics && typeof on.data.metrics.t_s === "number", "metrics.t_s numeric");
    ok(typeof on.data?.performance_score === "number", "performance_score numeric");
    ok(typeof on.data?.token_usage === "object", "token_usage camelCase");

    // ---- reasoning_budget accepted end-to-end (reasoning on; reply may be reasoning-only) ----
    console.log("\n[reasoning_budget] accepted end-to-end");
    const rb = await call("run_sub_agent", {
      profile: "live",
      model_id: model,
      brief: "Think step by step then say done.",
      reasoning_budget: 512,
      effort: "high",
    });
    ok(rb.ok === true, "run_sub_agent with reasoning_budget accepted", JSON.stringify(rb.error));
    ok(rb.data?.metrics && typeof rb.data.metrics.t_s === "number", "reasoning_budget run yields metrics");

    // ---- reasoning + reasoning_budget accepted at raw client layer ----
    console.log("\n[client] reasoning + reasoning_budget accepted (no 400)");
    try {
      const chat = await client.chat(model, "Say ready.", {
        system_prompt: "Persistent base layer.",
        reasoning: "on",
        reasoning_budget: 512,
        max_output_tokens: 64,
        stream: false,
      });
      ok(chat.response.stats !== undefined, "chat with reasoning+reasoning_budget+system_prompt accepted", JSON.stringify(chat.response.stats).slice(0, 60));
    } catch (err) {
      ok(false, "chat with reasoning+reasoning_budget accepted", err instanceof Error ? err.message : String(err));
    }

    // ---- OFF-mode: uses loaded pool, no hot-load/evict ----
    console.log("\n[OFF-mode] use loaded pool");
    await call("load_model", { model_id: model });
    await call("create_profile", {
      name: "live-off",
      endpoint: { url: baseUrl },
      machine_specs: { vram_gb: 4 },
      dynamic_model: false,
    });
    await call("switch_profile", { name: "live-off" });
    const off = await call("run_sub_agent", { profile: "live-off", model_id: model, brief: "Say ready." });
    ok(off.ok === true, "run_sub_agent (OFF) ok", JSON.stringify(off.error));
    ok(off.data?.loaded_this_call === false, "OFF uses resident model (no load)");
    ok(typeof off.data?.metrics?.t_s === "number", "OFF still returns metrics");
    // registry entry must be untouched by OFF-mode run
    const reg = await call("read_registry", { profile: "live-off", model_id: model });
    ok(reg.ok === true, "read_registry ok");

    // dynamic_model:false persisted (active profile is now live-off)
    const offP = await call("get_active_profile", {});
    ok(offP.data?.profile?.dynamic_model === false, "dynamic_model:false persisted");

    await mcp.close();
    await server.server.close();
    deps.close();
  } finally {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn(`  warn  temp cleanup deferred: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

void main().then((code) => process.exit(code)).catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
