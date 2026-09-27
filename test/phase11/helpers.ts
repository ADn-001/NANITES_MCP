/**
 * Phase 11 harness: like the Phase 5 harness, but (a) records every tool call
 * by name for call-assertions (the gate demands "verify via call assertions,
 * not just final state"), (b) exposes getPrompt/listPrompts so slash commands
 * are exercised over the real MCP prompt primitive, and (c) can start with
 * zero profiles so the first-run flow is testable.
 */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "../../src/server/buildServer.js";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { sendJson, sendChatStream, wantsStream, startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import { chatResponseFixture, listModelsFixture, loadModelFixture, unloadModelFixture } from "../phase1/fixtures.js";
import type { Profile } from "../../src/storage/profileDefaults.js";

export interface CallResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: unknown };
}

export interface Phase11Harness {
  deps: ToolDeps;
  profile: Profile | null;
  mock: MockLmStudio;
  calls: Array<{ name: string; args: unknown }>;
  callTool(name: string, args: unknown): Promise<CallResult>;
  callToolRaw(name: string, args: unknown): Promise<{ isError: boolean; text: string }>;
  getPrompt(name: string, args?: Record<string, unknown>): Promise<{ text: string; title?: string; description?: string }>;
  listPrompts(): Promise<string[]>;
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
    case "/api/v1/chat":
      // Mirror real LM Studio: `stream: true` requests are answered over SSE.
      return wantsStream(body) ? sendChatStream(res, chatResponseFixture as unknown as Record<string, unknown>) : sendJson(res, 200, chatResponseFixture);
    default:
      return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
  }
}

export async function createPhase11Harness(opts: { createProfile?: boolean } = {}): Promise<Phase11Harness> {
  const createProfile = opts.createProfile ?? true;
  const home = scratchHome();
  const deps = buildDeps(home);
  const mock = await startMockLmStudio(liveHandler);

  let profile: Profile | null = null;
  if (createProfile) {
    profile = deps.profiles.createProfile({
      name: "t",
      endpoint: { url: mock.url },
      machine_specs: { vram_gb: 4 },
    });
    deps.profiles.switchProfile("t");
  }

  const server = buildServer({ home, deps });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase11-harness", version: "0.0.1" });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);

  const calls: Array<{ name: string; args: unknown }> = [];

  return {
    deps,
    profile,
    mock,
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
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
        return { isError: true, text: err instanceof Error ? err.message : String(err) };
      }
    },
    async getPrompt(name, args) {
      const result = await client.getPrompt({ name, arguments: (args ?? {}) as Record<string, unknown> });
      const text = result.messages.map((m) => {
        const c = m.content;
        return c.type === "text" ? c.text : "";
      }).join("\n");
      return { text, title: result.description, description: result.description };
    },
    async listPrompts() {
      const { prompts } = await client.listPrompts();
      return prompts.map((p) => p.name);
    },
    async close() {
      await client.close();
      await server.close();
      try {
        deps.close();
      } catch {
        // already closed
      }
      await mock.close().catch(() => {});
      cleanup(home);
    },
  };
}
