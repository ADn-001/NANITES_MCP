#!/usr/bin/env tsx
/**
 * LIVE CONNECT TEST — spawns the real stdio MCP server (`node dist/index.js`),
 * connects an MCP client over real stdio pipes, and drives the tool surface
 * end-to-end against the real LM Studio at NANITES_LM_BASE_URL (default
 * http://localhost:1234).
 *
 * Uses a scratch NANITES_HOME so it never touches the user's real ~/.nanites.
 * Not part of CI; skip-if-unreachable for LM Studio.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE_URL = process.env.NANITES_LM_BASE_URL ?? "http://localhost:1234";
// NOTE: must be the raw LM Studio `key` (load identifier), NOT `publisher/key`.
// See the model-identifier mismatch flagged during the live test.
const MODEL = process.env.NANITES_LM_MODEL ?? "qwen3.5-2b";

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: unknown };
}

const home = mkdtempSync(path.join(tmpdir(), "nanites-live-"));
const transport = new StdioClientTransport({
  command: process.execPath, // node
  args: [path.resolve("dist/index.js")],
  env: { ...process.env, NANITES_HOME: home } as Record<string, string>,
  cwd: process.cwd(),
  stderr: "pipe",
});

// Mirror server stderr to our stderr so startup errors are visible.
(transport as unknown as { stderr?: NodeJS.ReadableStream }).stderr?.on?.("data", (d: Buffer) => {
  process.stderr.write(`[nanites] ${d.toString()}`);
});

const client = new Client({ name: "live-connect-test", version: "0.0.1" });

function log(step: string, detail?: unknown): void {
  const suffix = detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`;
  console.log(`\n=== ${step}${suffix}`);
}

async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Envelope;
}

async function main(): Promise<number> {
  await client.connect(transport);

  const { tools } = await client.listTools();
  log("listTools", `${tools.length} tools registered`);

  const ping = await call("nanites_ping", {});
  log("nanites_ping", ping);

  // --- first-run / profile setup against real LM Studio ---
  const first = await call("get_first_run_status", {});
  log("get_first_run_status", first.data);

  const created = await call("create_profile", {
    name: "live",
    endpoint: { url: BASE_URL },
    machine_specs: { vram_gb: 4 },
    use_case: "nanites-default",
  });
  log("create_profile", created.ok ? { name: (created.data as any)?.name } : created.error);

  const switched = await call("switch_profile", { name: "live" });
  log("switch_profile", switched.data);

  const active = await call("get_active_profile", {});
  log("get_active_profile", active.data);

  // --- health (should reach LM Studio + autostart-recover if needed) ---
  const health = await call("system_health_check", { profile: "live" });
  log("system_health_check", health.data);

  // --- inference tools ---
  const listed = await call("list_models", {});
  const models = ((listed.data as any)?.models ?? []) as Array<{ model: string; loaded_instance_ids: string[] }>;
  log("list_models", `${models.length} models`);

  const loaded0 = await call("get_loaded_model", {});
  log("get_loaded_model", loaded0.data);

  const load = await call("load_model", { model_id: MODEL });
  log(`load_model ${MODEL}`, load.data ?? load.error);

  const loaded1 = await call("get_loaded_model", {});
  log("get_loaded_model (after load)", loaded1.data);

  const instanceId = ((loaded1.data as any)?.models?.[0]?.loaded_instance_ids?.[0]) as string | undefined;
  if (!instanceId) {
    console.error("FAIL: load_model did not produce a loaded instance id.");
    return 1;
  }

  const chat = await call("chat", {
    instance_id: instanceId,
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "Reply with the single word: pong" },
    ],
    params: { max_output_tokens: 16 },
    timeout_s: 120,
  });
  log("chat", chat.data ?? chat.error);

  // --- delegation (run_sub_agent) ---
  const sub = await call("run_sub_agent", {
    profile: "live",
    brief: "Tell me, in one sentence, what 2+2 equals.",
    roles: ["summarizer"],
    model_id: MODEL,
  });
  log("run_sub_agent", sub.data ?? sub.error);

  // --- cost report ---
  const cost = await call("get_cost_saved_report", { profile: "live" });
  log("get_cost_saved_report", cost.data);

  // --- unload ---
  const unload = await call("unload_model", { instance_id: instanceId });
  log("unload_model", unload.data);

  await client.close();
  return 0;
}

main()
  .then((code) => {
    console.log(code === 0 ? "\nPASS: live connect test completed." : "\nFAIL: live connect test.");
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`\nFAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await client.close();
    } catch {
      // already closed
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Windows may hold the SQLite handle a moment longer; ignore.
    }
  });
