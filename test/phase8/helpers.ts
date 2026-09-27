/**
 * Phase 8 harness: a STATE-FUL mock LM Studio whose loaded-models view is
 * derived from live load/unload calls, so Workflow #2's acquire policy (reuse
 * already-loaded / evict on sequential tiers / refuse at parallel capacity) is
 * asserted against the same endpoint it drives. Unlike the Phase 7 static
 * fixture, listModels here reflects in-memory state over time.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { runSubAgent, type SubAgentOptions, type SubAgentResult } from "../../src/workflows/runSubAgent.js";
import { SubAgentPool } from "../../src/workflows/subAgentPool.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";
import type { ToolsConfig } from "../../src/storage/profileDefaults.js";
import type { ChatOutputItem } from "../../src/lmstudio/types.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import {
  openChatStream,
  sendJson,
  sendChatStream,
  sendOpenAiChatStream,
  wantsStream,
  startMockLmStudio,
  type MockLmStudio,
} from "../phase1/mockServer.js";
import { chatResponseFixture } from "../phase1/fixtures.js";

export interface SubAgentMockOptions {
  /** vram_gb for the created profile (drives the concurrency tier). Default 4 = sequential/1. */
  vramGb?: number;
  /** dynamic_model for the created profile. Default true (hot-load). */
  dynamicModel?: boolean;
  /** Model loaded at startup, e.g. "gemma-3-270m-it-qat". */
  initiallyLoaded?: string[];
  /** Registry entries seeded after profile creation. */
  registry?: RegistryEntry[];
  chatReply?: string;
  chatDelayMs?: number;
  chatFail?: boolean;
  /** Phase B: emit `message.delta` chunks spaced by `gapMs` (slow-but-alive)
   * instead of one synchronous SSE flush; `chat.end` fires after `chunkCount`
   * deltas so the run completes well past a small fixed budget. */
  chatSlow?: { gapMs: number; chunkCount: number };
  /** Phase B: open the SSE stream, send `chat.start` + a delta, then never
   * end it — the client's idle kill is what tears it down. */
  chatStall?: boolean;
  loadFail?: boolean;
  /** Phase B: delay the blocking load POST by this many ms while still
   * answering heartbeat GETs — a slow-but-alive load must complete. */
  loadDelayMs?: number;
  /** Simulate a reasoning model: report reasoning_output_tokens > 0 in chat stats. */
  reasoningOutputTokens?: number;
  /** Tool grant for the created profile; when present, runSubAgent attaches these integrations. */
  tools?: ToolsConfig;
  /** Full chat output array override (e.g. tool_call + final message) for tool-loop tests. */
  toolOutputs?: ChatOutputItem[];
  /** Delay the openai/ttl /v1/chat/completions response by this many ms (mirror of chatDelayMs for the ttl transport). */
  openAiDelayMs?: number;
  /** inference.ttl_s on the created profile (>0 routes tool-less runs to
   * /v1/chat/completions; 0/absent keeps the native load/teardown path). */
  ttl_s?: number;
}

export interface RunAgentOptions {
  brief?: string;
  roles?: string[];
  model_id?: string;
  task?: string;
  effort?: "low" | "medium" | "high";
  system_prompt_override?: string;
  reasoning_budget?: number;
  clientTimeoutMs?: number;
  pool?: SubAgentPool;
  /** Phase A: keep the loaded instance warm (skip teardown), handing it to the caller. */
  hold?: SubAgentOptions["hold"];
  /** Phase B: override the generation idle window (default 30s). */
  idle_timeout_ms?: number;
}

export interface SubAgentHarness {
  deps: ToolDeps;
  mock: MockLmStudio;
  counts: { loads: number; unloads: number; chats: number };
  /** modelId -> instance id currently loaded on the mock. */
  loaded: Map<string, string>;
  /** Last /api/v1/chat request body (for asserting planner-driven params). */
  lastChat?: Record<string, unknown>;
  /** Last /api/v1/models/load request body (for asserting context_length). */
  lastLoad?: Record<string, unknown>;
  /** Requests that hit /v1/chat/completions (the openai/ttl transport). */
  openAiChats: () => number;
  /** Last /v1/chat/completions request body (for asserting ttl + translation). */
  lastOpenAi?: () => Record<string, unknown> | undefined;
  /** Every /v1/chat/completions request body, in order. */
  openAiBodies: () => Array<Record<string, unknown>>;
  runAgent(opts?: RunAgentOptions): Promise<SubAgentResult>;
  close(): Promise<void>;
}

export async function createSubAgentHarness(opts: SubAgentMockOptions = {}): Promise<SubAgentHarness> {
  const home = scratchHome();
  const deps = buildDeps(home);
  const counts = { loads: 0, unloads: 0, chats: 0 };
  const openAiState = {
    count: 0,
    last: undefined as Record<string, unknown> | undefined,
    bodies: [] as Array<Record<string, unknown>>,
  };
  const loaded = new Map<string, string>();
  for (const modelId of opts.initiallyLoaded ?? []) loaded.set(modelId, modelId);
  const harness: Partial<SubAgentHarness> = { counts, loaded };

  const mock = await startMockLmStudio(async (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? "/", "http://mock");
    switch (url.pathname) {
      case "/api/v1/models":
        return sendJson(res, 200, {
          models: [...loaded.entries()].map(([modelId, instanceId]) => ({
            type: "llm",
            publisher: "mock",
            key: modelId, // the identifier `acquireModel` matches on is the key itself
            display_name: modelId,
            quantization: null,
            size_bytes: 0,
            params_string: null,
            loaded_instances: [{ id: instanceId, config: { context_length: 4096 } }],
            max_context_length: 4096,
            format: "gguf",
          })),
        });
      case "/api/v1/models/load": {
        counts.loads++;
        if (opts.loadFail) return sendJson(res, 500, { error: "load failed" });
        if (opts.loadDelayMs) await new Promise((r) => setTimeout(r, opts.loadDelayMs));
        const parsed = JSON.parse(body) as { model?: string };
        harness.lastLoad = parsed;
        const modelId = parsed.model ?? "";
        loaded.set(modelId, modelId);
        return sendJson(res, 200, { type: "llm", instance_id: modelId, load_time_seconds: 0.1, status: "loaded" });
      }
      case "/api/v1/models/unload": {
        counts.unloads++;
        const parsed = JSON.parse(body) as { instance_id?: string };
        const instanceId = parsed.instance_id ?? "";
        for (const [mid, iid] of loaded) if (iid === instanceId) loaded.delete(mid);
        return sendJson(res, 200, { instance_id: instanceId });
      }
      case "/api/v1/chat": {
        counts.chats++;
        if (opts.chatFail) return sendJson(res, 500, { error: "chat failed" });
        if (opts.chatDelayMs) await new Promise((r) => setTimeout(r, opts.chatDelayMs));
        harness.lastChat = JSON.parse(body) as Record<string, unknown>;
        const response = {
          ...chatResponseFixture,
          stats: opts.reasoningOutputTokens
            ? { ...chatResponseFixture.stats, reasoning_output_tokens: opts.reasoningOutputTokens }
            : chatResponseFixture.stats,
          output: opts.toolOutputs ?? [{ type: "message", content: opts.chatReply ?? "done" }],
        };
        // Mirror real LM Studio: `stream: true` requests are answered over SSE.
        if (!wantsStream(body)) return sendJson(res, 200, response);
        // Phase B: a stream that never ends (chat.start + one delta, then open).
        // Only the client's idle kill tears it down.
        if (opts.chatStall) {
          const emit = openChatStream(res);
          emit("chat.start", {});
          emit("message.start", { role: "assistant" });
          emit("message.delta", { content: "partial " });
          return;
        }
        // Phase B: deltas arriving on a schedule — alive but slow, finishing
        // well past a small fixed budget.
        if (opts.chatSlow) {
          const emit = openChatStream(res);
          emit("chat.start", {});
          emit("message.start", { role: "assistant" });
          const reply = opts.chatReply ?? "done";
          let sent = 0;
          const tick = (): void => {
            sent++;
            emit("message.delta", { content: `${reply} part ${sent} ` });
            if (sent >= opts.chatSlow!.chunkCount) {
              emit("message.end", {});
              emit("chat.end", { result: response });
              res.end();
              return;
            }
            setTimeout(tick, opts.chatSlow!.gapMs);
          };
          setTimeout(tick, opts.chatSlow!.gapMs);
          return;
        }
        return sendChatStream(res, response);
      }
      case "/v1/chat/completions": {
        // OpenAI-compat /ttl transport. No load/unload ever happens on this
        // path (LM Studio JIT owns the lifecycle), so the route only counts
        // chats + captures the body.
        openAiState.count++;
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        openAiState.last = parsedBody;
        openAiState.bodies.push(parsedBody);
        if (opts.openAiDelayMs) await new Promise((r) => setTimeout(r, opts.openAiDelayMs));
        return sendOpenAiChatStream(res, opts.chatReply ?? "done");
      }
      default:
        return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
    }
  });

  deps.profiles.createProfile({
    name: "t",
    endpoint: { url: mock.url },
    machine_specs: { vram_gb: opts.vramGb ?? 4 },
    ...(opts.dynamicModel !== undefined ? { dynamic_model: opts.dynamicModel } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.ttl_s !== undefined ? { inference: { ttl_s: opts.ttl_s } } : {}),
  });
  for (const entry of opts.registry ?? []) deps.registry.upsert("t", entry);

  return {
    deps,
    mock,
    counts,
    loaded,
    lastChat: () => harness.lastChat,
    lastLoad: () => harness.lastLoad,
    openAiChats: () => openAiState.count,
    lastOpenAi: () => openAiState.last,
    openAiBodies: () => openAiState.bodies,
    runAgent: (args: RunAgentOptions = {}) =>
      runSubAgent(deps, "t", args.brief ?? "Review this file for bugs.", {
        roles: args.roles,
        model_id: args.model_id,
        task: args.task,
        effort: args.effort,
        system_prompt_override: args.system_prompt_override,
        reasoning_budget: args.reasoning_budget,
        ...(args.clientTimeoutMs !== undefined ? { clientTimeoutMs: args.clientTimeoutMs } : {}),
        ...(args.pool !== undefined ? { pool: args.pool } : {}),
        ...(args.hold !== undefined ? { hold: args.hold } : {}),
        ...(args.idle_timeout_ms !== undefined ? { idle_timeout_ms: args.idle_timeout_ms } : {}),
      }),
    async close() {
      await mock.close().catch(() => {});
      deps.close();
      cleanup(home);
    },
  };
}
