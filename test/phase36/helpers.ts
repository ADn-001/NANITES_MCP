/**
 * Phase 36 harness: context-faithful mock LM Studio. Unlike the phase 7/9
 * masks (which always report a resident context of 32768), this harness
 * *records the context_length requested on every load* and reports that exact
 * value back through listModels, so the ascending-context acquisition logic in
 * runTestRegimen can actually fire and be asserted. It also counts
 * load/unload/chat, records every chat body (to prove `context_length` never
 * reaches the wire), and can preload a same-key resident (user-already-loaded)
 * at any context. An optional ntfy capture server records fire-and-forget
 * pushes when a profile topic is configured.
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import type { TestUnit } from "../../src/testunits/schema.js";
import { runTestRegimen, type RunRegimenSummary } from "../../src/workflows/runTestRegimen.js";
import { runUntestedSweep, type SweepResult } from "../../src/workflows/runUntestedSweep.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { sendJson, sendChatStream, startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import { chatResponseFixture } from "../phase1/fixtures.js";

export interface ModelSpec {
  key: string;
  max_context_length: number;
  size_bytes?: number;
  /** Preload a user-resident instance of this model at this context. */
  resident_ctx?: number;
}

export interface CapturePush {
  url: string;
  body: string;
  tags: string | null;
}

export interface NtfyOption {
  topic: string | null;
}

export interface ContextHarnessOpts {
  models?: ModelSpec[];
  reply?: (prompt: string) => string;
  vramGb?: number;
  dynamicModel?: boolean;
  /** When present a capture server is started and its URL used as the profile's
   * ntfy.server_url; topic null exercises the no-topic short circuit. */
  ntfy?: NtfyOption;
}

export interface RegimenCounterState {
  loads: number;
  unloads: number;
  chats: number;
  loadCtxs: number[];
  chatBodies: Record<string, unknown>[];
}

export interface ContextHarness {
  deps: ToolDeps;
  mock: MockLmStudio;
  counts: RegimenCounterState;
  pushes: CapturePush[];
  /** Register a custom unit (also prevents the default regimen from loading). */
  addUnit(unit: TestUnit): void;
  runRegimen(modelId: string, opts?: { clientTimeoutMs?: number }): Promise<RunRegimenSummary>;
  runSweep(): Promise<SweepResult>;
  /** Snapshot of currently-loaded instances: Array<{model,id,ctx}>. */
  loadedNow(): Array<{ model: string; id: string; ctx: number }>;
  close(): Promise<void>;
}

export async function waitFor(cond: () => boolean, timeoutMs = 4_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function detJsonUnit(id: string, contextLength: number, promptText: string): TestUnit {
  return {
    id,
    name: id,
    task_group: "ctx-test",
    difficulty: "easy",
    prompts: [{ id: `${id}.p`, text: promptText, expected: null, notes: null }],
    measures: ["format_compliance"],
    applicable_roles: ["coder"],
    recommended_config: {
      context_length: contextLength,
      kv_cache_quant: "Q4",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.0,
      max_output_tokens: 128,
    },
    scoring: { method: "deterministic_rule", rule: { type: "json_valid", params: {} } },
    source: "custom_authored",
    version: 1,
  };
}

export async function createContextHarness(opts: ContextHarnessOpts = {}): Promise<ContextHarness> {
  const home = scratchHome();
  const deps = buildDeps(home);
  const models = opts.models ?? [{ key: "m", max_context_length: 32768 }];
  const counts: RegimenCounterState = { loads: 0, unloads: 0, chats: 0, loadCtxs: [], chatBodies: [] };
  const loaded: Array<{ model: string; id: string; ctx: number }> = [];
  for (const spec of models) {
    if (spec.resident_ctx) loaded.push({ model: spec.key, id: `${spec.key}-resident`, ctx: spec.resident_ctx });
  }
  let seq = 0;
  const replies = opts.reply ?? (() => '{"ok":true}');

  const knownByKey = new Map(models.map((m) => [m.key, m]));
  const mock = await startMockLmStudio(async (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? "/", "http://mock");
    switch (url.pathname) {
      case "/api/v1/models": {
        const out: Record<string, unknown>[] = [];
        for (const spec of models) {
          const insts = loaded.filter((l) => l.model === spec.key).map((l) => ({ id: l.id, config: { context_length: l.ctx } }));
          out.push({
            type: "llm",
            publisher: "lmstudio-community",
            key: spec.key,
            display_name: spec.key,
            quantization: { name: "Q4_0", bits_per_weight: 4 },
            size_bytes: spec.size_bytes ?? 1_000_000_000,
            params_string: null,
            loaded_instances: insts,
            max_context_length: spec.max_context_length,
            format: "gguf",
          });
        }
        for (const l of loaded) {
          if (knownByKey.has(l.model)) continue;
          out.push({
            type: "llm",
            publisher: "",
            key: l.model,
            display_name: l.model,
            quantization: { name: "Q4_0", bits_per_weight: 4 },
            size_bytes: 0,
            params_string: null,
            loaded_instances: [{ id: l.id, config: { context_length: l.ctx } }],
            max_context_length: 32768,
            format: "gguf",
          });
        }
        return sendJson(res, 200, { models: out });
      }
      case "/api/v1/models/load": {
        counts.loads++;
        const parsed = JSON.parse(body) as { model?: string; context_length?: number };
        const ctx = typeof parsed.context_length === "number" ? parsed.context_length : 0;
        counts.loadCtxs.push(ctx);
        const id = `inst-${++seq}`;
        loaded.push({ model: parsed.model ?? "", id, ctx });
        return sendJson(res, 200, {
          type: "llm",
          instance_id: id,
          load_time_seconds: 0.5,
          status: "loaded",
          load_config: { context_length: ctx || undefined },
        });
      }
      case "/api/v1/models/unload": {
        counts.unloads++;
        const parsed = JSON.parse(body) as { instance_id?: string };
        const target = parsed.instance_id ?? "";
        for (let i = loaded.length - 1; i >= 0; i--) {
          if (loaded[i]!.id === target) loaded.splice(i, 1);
        }
        return sendJson(res, 200, { instance_id: target });
      }
      case "/api/v1/chat": {
        counts.chats++;
        const parsed = JSON.parse(body) as Record<string, unknown>;
        counts.chatBodies.push(parsed);
        const input = parsed.input;
        const prompt = typeof input === "string" ? input : String((input as { content: string }[])?.[0]?.content ?? "");
        const reply = replies(prompt);
        const response = { ...chatResponseFixture, output: [{ type: "message", content: reply }] };
        return sendChatStream(res, response);
      }
      default:
        return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
    }
  });

  // Optional ntfy capture: any POST is recorded (never forwarded upstream).
  let pushes: CapturePush[] = [];
  let ntfyBase: string | null = null;
  let closeCapture: (() => Promise<void>) | null = null;
  if (opts.ntfy) {
    pushes = [];
    const capture = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        pushes.push({ url: req.url ?? "", body: raw, tags: (req.headers["tags"] as string) ?? null });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => capture.listen(0, "127.0.0.1", r));
    ntfyBase = `http://127.0.0.1:${(capture.address() as AddressInfo).port}`;
    closeCapture = () => new Promise<void>((r) => capture.close(() => r()));
  }

  deps.profiles.createProfile({
    name: "t",
    endpoint: { url: mock.url },
    machine_specs: { vram_gb: opts.vramGb ?? 4 },
    dynamic_model: opts.dynamicModel ?? true,
    ntfy: opts.ntfy ? { topic: opts.ntfy.topic, server_url: ntfyBase ?? undefined } : undefined,
  });

  return {
    deps,
    mock,
    counts,
    pushes,
    addUnit(unit) {
      deps.testUnits.register("t", unit);
    },
    runRegimen: (modelId, o = {}) => runTestRegimen(deps, "t", modelId, { ...o }),
    runSweep: () => runUntestedSweep(deps, "t"),
    loadedNow: () => loaded.map((l) => ({ ...l })),
    async close() {
      if (closeCapture) await closeCapture();
      await mock.close().catch(() => {});
      deps.close();
      cleanup(home);
    },
  };
}
