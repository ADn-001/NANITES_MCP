#!/usr/bin/env tsx
/**
 * REGISTER PROFILE — connects to the real stdio MCP server against the user's
 * real ~/.nanites (no scratch home), creates the GTX 1650 profile, switches to
 * it, and runs one real sub-agent delegation to collect live data.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";

const BASE_URL = process.env.NANITES_LM_BASE_URL ?? "http://127.0.0.1:1234";
const MODEL = process.env.NANITES_LM_MODEL ?? "qwen3.5-2b";

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: unknown };
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js")],
  env: { ...process.env } as Record<string, string>,
  cwd: process.cwd(),
  stderr: "pipe",
});

(transport as unknown as { stderr?: NodeJS.ReadableStream }).stderr?.on?.("data", (d: Buffer) => {
  process.stderr.write(`[nanites] ${d.toString()}`);
});

const client = new Client({ name: "register-profile", version: "0.0.1" });

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

  const created = await call("create_profile", {
    name: "gtx1650",
    endpoint: { url: BASE_URL },
    machine_specs: {
      cpu: "Ryzen 5 5600H",
      gpu: "GTX 1650",
      vram_gb: 4,
      ram_gb: 16,
      storage: "SSD",
    },
    pricing: { input_per_million_usd: 0.44, output_per_million_usd: 1.32 },
    use_case: "nanites-default",
  });
  log("create_profile", created.ok ? created.data : created.error);

  const switched = await call("switch_profile", { name: "gtx1650" });
  log("switch_profile", switched.data);

  const active = await call("get_active_profile", {});
  log("get_active_profile", active.data);

  const health = await call("system_health_check", { profile: "gtx1650" });
  log("system_health_check", health.data);

  // One real delegation to collect live data on the summary task.
  const sub = await call("run_sub_agent", {
    profile: "gtx1650",
    brief:
      "In three bullet points, summarize the fix that changed model identifiers from publisher/key to the raw model key in the Nanites MCP server.",
    roles: ["summarizer"],
    model_id: MODEL,
  });
  log("run_sub_agent", sub.data ?? sub.error);

  const cost = await call("get_cost_saved_report", { profile: "gtx1650" });
  log("get_cost_saved_report", cost.data);

  await client.close();
  return 0;
}

main()
  .then((code) => {
    console.log(code === 0 ? "\nDONE: profile registered + live delegation run." : "\nFAILED.");
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
  });
