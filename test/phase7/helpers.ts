/**
 * Phase 7 harness: a mock LM Studio whose chat responses are controllable per
 * prompt, with load/unload/chat call counting so the "unload exactly once on
 * every path" gate can be asserted via call counts, not just end state.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { runTestRegimen, type RunRegimenSummary } from "../../src/workflows/runTestRegimen.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { openChatStream, sendChatStream, sendJson, startMockLmStudio, wantsStream, type MockLmStudio } from "../phase1/mockServer.js";
import { chatResponseFixture, listModelsFixture, loadModelFixture, unloadModelFixture } from "../phase1/fixtures.js";

export interface RegimenMockOptions {
  /** Return the reply text for a prompt, or undefined to make the chat fail (HTTP 500). */
  replies?: (prompt: string) => string | undefined;
  /** When set, every chat waits this long before responding — for timeout tests. */
  chatDelayMs?: number;
  /** When true, POST /models/load fails with HTTP 500. */
  loadFailure?: boolean;
  /** Phase B: every streaming chat opens, sends chat.start + a delta, then
   * never ends — a mid-run stall the client's idle kill tears down. */
  chatStall?: boolean;
  /** List the fixture's gemma as holding a resident loaded instance. Default
   * false — a regimen run sees a fresh endpoint (nothing loaded) and does one
   * clean load/unload cycle. true models the user-already-loaded case that
   * acquire/reuse protects: the regimen reuses the resident copy instead of
   * spawning a duplicate :2 instance. */
  residentGemma?: boolean;
}

export interface RegimenHarness {
  deps: ToolDeps;
  mock: MockLmStudio;
  counts: { loads: number; unloads: number; chats: number };
  /** Last POST /api/v1/models/load request body (CP-3 concurrency-slot assert). */
  lastLoad?: Record<string, unknown>;
  runRegimen(modelId: string, opts?: { clientTimeoutMs?: number; idle_timeout_ms?: number }): Promise<RunRegimenSummary>;
  close(): Promise<void>;
}

/** Deterministic units' prompts all resolve to their expected outputs. */
export function passAllReplies(prompt: string): string {
  if (prompt.includes("commit message as JSON")) return '{"type":"fix","scope":"auth","summary":"x"}';
  if (prompt.includes("Extract as JSON")) return '{"error_code":null,"file":"a.ts","line":42,"message":"x"}';
  if (prompt.includes("export my data")) return "QUESTION";
  if (prompt.includes("crashes every time")) return "BUG";
  if (prompt.includes("would be nice")) return "FEATURE";
  if (prompt.includes("whole megabytes")) return "7";
  if (prompt.includes("no extractable email")) return "NONE";
  return "ok";
}

export async function createRegimenHarness(opts: RegimenMockOptions = {}): Promise<RegimenHarness> {
  const home = scratchHome();
  const deps = buildDeps(home);
  const counts = { loads: 0, unloads: 0, chats: 0 };
  const harness: Partial<RegimenHarness> = { counts };
  // Live resident instances keyed by model key. listModels overlays this onto
  // the fixture (appending keys absent from it, e.g. `openai/gpt-oss-20b`), so
  // key-wide teardown (unloadModelKey on dynamic profiles) sees what it loaded.
  const loaded: Record<string, string[]> = {};
  const fixtureKey = (listModelsFixture.models.find((m) => m.type === "llm") ?? listModelsFixture.models[0]!).key;
  const fixtureId = listModelsFixture.models.find((m) => m.type === "llm")?.loaded_instances[0]?.id ?? fixtureKey;
  if (opts.residentGemma) loaded[fixtureKey] = [fixtureId];

  const replies = opts.replies ?? (() => "ok");
  const mock = await startMockLmStudio(async (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? "/", "http://mock");
    switch (url.pathname) {
      case "/api/v1/models": {
        const fx = structuredClone(listModelsFixture) as typeof listModelsFixture;
        const present = new Set(fx.models.map((m) => m.key));
        for (const m of fx.models) {
          m.loaded_instances = (loaded[m.key] ?? []).map((id) => ({ id, config: { context_length: 32768 } }));
        }
        for (const [key, ids] of Object.entries(loaded)) {
          if (present.has(key)) continue;
          fx.models.push({
            type: "llm",
            publisher: "",
            key,
            display_name: key,
            quantization: { name: "Q4_0", bits_per_weight: 4 },
            size_bytes: 0,
            params_string: null,
            loaded_instances: ids.map((id) => ({ id, config: { context_length: 32768 } })),
            max_context_length: 32768,
            format: "gguf",
          });
        }
        return sendJson(res, 200, fx);
      }
      case "/api/v1/models/load":
        counts.loads++;
        if (opts.loadFailure) return sendJson(res, 500, { error: "load failed" });
        const loadBody = JSON.parse(body) as Record<string, unknown>;
        harness.lastLoad = loadBody;
        const loadKey = (loadBody.model as string) ?? "";
        const loadId = loadModelFixture.instance_id;
        loaded[loadKey] = [loadId];
        return sendJson(res, 200, loadModelFixture);
      case "/api/v1/models/unload":
        counts.unloads++;
        const unloadId = (JSON.parse(body) as { instance_id?: string }).instance_id ?? "";
        for (const k of Object.keys(loaded)) {
          loaded[k] = loaded[k]!.filter((x) => x !== unloadId);
          if (loaded[k]!.length === 0) delete loaded[k];
        }
        return sendJson(res, 200, unloadModelFixture);
      case "/api/v1/chat": {
        counts.chats++;
        if (opts.chatDelayMs) await new Promise((r) => setTimeout(r, opts.chatDelayMs));
        const parsed = JSON.parse(body) as { input?: unknown };
        const prompt = typeof parsed.input === "string" ? parsed.input : String((parsed.input as { content: string }[])?.[0]?.content ?? "");
        const reply = replies(prompt);
        if (reply === undefined) return sendJson(res, 500, { error: "chat failed" });
        // Regimen chats stream since Phase B; mirror real LM Studio and answer
        // `stream: true` requests over SSE (same shape as the non-streaming one).
        const response = { ...chatResponseFixture, output: [{ type: "message", content: reply }] };
        if (!wantsStream(body)) return sendJson(res, 200, response);
        if (opts.chatStall) {
          const emit = openChatStream(res);
          emit("chat.start", {});
          emit("message.start", { role: "assistant" });
          emit("message.delta", { content: "partial " });
          return;
        }
        return sendChatStream(res, response);
      }
      default:
        return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
    }
  });

  deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url }, machine_specs: { vram_gb: 4 } });

  return {
    deps,
    mock,
    counts,
    get lastLoad() {
      return harness.lastLoad;
    },
    runRegimen: (modelId, opts2 = {}) =>
      runTestRegimen(deps, "t", modelId, {
        ...(opts2.clientTimeoutMs !== undefined ? { clientTimeoutMs: opts2.clientTimeoutMs } : {}),
        ...(opts2.idle_timeout_ms !== undefined ? { idle_timeout_ms: opts2.idle_timeout_ms } : {}),
      }),
    async close() {
      await mock.close().catch(() => {});
      deps.close();
      cleanup(home);
    },
  };
}
