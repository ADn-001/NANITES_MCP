import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildServer } from "../../src/server/buildServer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILT_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const STDLIB_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-stdio-test-"));

afterAll(() => {
  fs.rmSync(STDLIB_SCRATCH, { recursive: true, force: true });
});

/** The full §2 tool surface (plus the liveness probe). */
const EXPECTED_TOOLS = [
  "list_models",
  "get_loaded_model",
  "load_model",
  "unload_model",
  "chat",
  "download_model",
  "get_download_status",
  "read_registry",
  "write_registry_entry",
  "create_profile",
  "switch_profile",
  "list_profiles",
  "get_active_profile",
  "list_test_units",
  "validate_test_unit",
  "register_test_unit",
  "run_test_regimen",
  "get_pending_judgments",
  "submit_test_judgment",
  "get_cost_saved_report",
  "system_health_check",
  "send_ntfy",
];

describe("MCP handshake (in-memory)", () => {
  it("boots, lists the ping probe plus every §2 tool, and answers a tool call", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer({ name: "nanites-test", version: "0.0.1-test", home: STDLIB_SCRATCH });
    const client = new Client({ name: "test-harness", version: "0.0.1" });

    await server.server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("nanites_ping");
    for (const expected of EXPECTED_TOOLS) {
      expect(names, `tool ${expected} is registered`).toContain(expected);
    }
    // Every tool carries a non-empty description (Phase 5 gate).
    for (const tool of tools) {
      expect(tool.description?.trim().length, `description for ${tool.name}`).toBeGreaterThan(0);
    }

    const result = await client.callTool({ name: "nanites_ping", arguments: {} });
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("nanites");

    await client.close();
    await server.close();
  });
});

describe("MCP handshake (real stdio boot)", () => {
  it("spawns the built server and answers tools/list over stdio", async () => {
    if (!fs.existsSync(BUILT_ENTRY)) {
      throw new Error(
        `Built server not found at ${BUILT_ENTRY}. Run "npm run build" before "npm test" (Phase 0 gate 1 precedes gate 2).`,
      );
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUILT_ENTRY],
      cwd: REPO_ROOT,
      env: { ...process.env, NANITES_HOME: STDLIB_SCRATCH },
    });
    const client = new Client({ name: "test-harness", version: "0.0.1" });

    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("nanites_ping");

    const result = await client.callTool({ name: "nanites_ping", arguments: {} });
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    expect(JSON.parse(text).ok).toBe(true);

    await client.close();
  });
});
