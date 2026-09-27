/**
 * Phase 5 harness: a real MCP server (in-memory transport) wired to the Phase
 * 1-4 internals, backed by a mock LM Studio endpoint. Tests drive the surface
 * exactly as Claude would — over tools/list + tools/call — so the gate
 * exercises schema validation and the structured error envelope end to end.
 */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "../../src/server/buildServer.js";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { sendJson, sendChatStream, wantsStream, startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import {
  chatResponseFixture,
  downloadModelFixture,
  downloadStatusFixture,
  listModelsFixture,
  loadModelFixture,
  unloadModelFixture,
} from "../phase1/fixtures.js";
import type { Profile } from "../../src/storage/profileDefaults.js";

export interface CallResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: unknown };
}

export interface ToolHarness {
  deps: ToolDeps;
  profile: Profile;
  mock: MockLmStudio;
  /** Parsed envelope from tools/call. */
  callTool(name: string, args: unknown): Promise<CallResult>;
  /** Raw SDK result for schema-rejection assertions (isError flag). */
  callToolRaw(name: string, args: unknown): Promise<{ isError: boolean; text: string }>;
  close(): Promise<void>;
}

export function liveHandler(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", "http://mock");
  switch (url.pathname) {
    case "/api/v1/models":
      return sendJson(res, 200, listModelsFixture);
    case "/api/v1/models/load":
      return sendJson(res, 200, loadModelFixture);
    case "/api/v1/models/unload":
      return sendJson(res, 200, unloadModelFixture);
    case "/api/v1/models/download":
      return sendJson(res, 200, downloadModelFixture);
    case "/api/v1/models/download/status/job_493c7c9ded":
      return sendJson(res, 200, downloadStatusFixture);
    case "/api/v1/chat":
      // Mirror real LM Studio: `stream: true` requests are answered over SSE.
      return wantsStream(body) ? sendChatStream(res, chatResponseFixture as unknown as Record<string, unknown>) : sendJson(res, 200, chatResponseFixture);
    default:
      return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
  }
}

export async function createHarness(opts: { dead?: boolean } = {}): Promise<ToolHarness> {
  const home = scratchHome();
  // Pin the health report's free-disk reading. `system_health_check` reports
  // `healthy` vs `degraded` partly from free space, so without this a test
  // asserting the verdict fails or passes depending on how full the host's
  // volume is. 500 GB is unambiguously "not low".
  const deps = buildDeps(home, { healthDisk: { availableGb: 500 } });

  // `dead`: bind a port, then release it, so the endpoint reliably refuses
  // connections (LM Studio "down").
  const mock = await startMockLmStudio(liveHandler);
  if (opts.dead) await mock.close();

  const profile = deps.profiles.createProfile({
    name: "t",
    endpoint: { url: mock.url },
    machine_specs: { vram_gb: 4 },
  });
  deps.profiles.switchProfile("t");

  const server = buildServer({ home, deps });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase5-harness", version: "0.0.1" });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    deps,
    profile,
    mock,
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      return JSON.parse(text) as CallResult;
    },
    async callToolRaw(name, args) {
      try {
        const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
        const text = result.content.find((c) => c.type === "text")?.text ?? "";
        return { isError: result.isError === true, text };
      } catch (err) {
        // Non-record arguments (e.g. a bare number) are rejected at the request
        // layer, which the client surfaces as a throw rather than an isError result.
        return { isError: true, text: err instanceof Error ? err.message : String(err) };
      }
    },
    async close() {
      await client.close();
      await server.close();
      try {
        deps.close();
      } catch {
        // already closed (broken-storage harness closes its own deps)
      }
      await mock.close().catch(() => {});
      cleanup(home);
    },
  };
}
