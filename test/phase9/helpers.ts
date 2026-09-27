/**
 * Phase 9 harness: mock LM Studio with controllable download lifecycle
 * (POST /models/download + GET /models/download/status/<job>), plus the
 * load/chat/unload routes Workflow #1 needs when a download is chained into a
 * test regimen. Status polls advance through a caller-provided sequence, so
 * completed/failed/paused/gave_up paths are asserted via endpoint behavior.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { downloadAndWait, type DownloadWaitOptions, type DownloadWaitResult } from "../../src/workflows/downloadAndWait.js";
import { downloadAndTest, type DownloadAndTestResult } from "../../src/workflows/downloadAndTest.js";
import { runUntestedSweep, type SweepResult } from "../../src/workflows/runUntestedSweep.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";
import type { DownloadStatusValue } from "../../src/lmstudio/types.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { sendChatStream, sendJson, startMockLmStudio, wantsStream, type MockLmStudio } from "../phase1/mockServer.js";
import { chatResponseFixture, listModelsFixture, loadModelFixture, unloadModelFixture } from "../phase1/fixtures.js";
import { passAllReplies } from "../phase7/helpers.js";

const JOB_ID = "job_493c7c9ded";

export interface DownloadHarnessOptions {
  /** Per-status-poll sequence; last value repeats. Default downloading->downloading->completed. */
  downloadStatuses?: DownloadStatusValue[];
  /** POST /models/download reports already_downloaded with no job id. */
  alreadyDownloaded?: boolean;
  /** Gemma (listModelsFixture) reports a resident loaded instance. Default
   * false — a fresh endpoint has downloaded models but nothing loaded, so a
   * regimen gets a clean load/unload cycle. true models the user-already-loaded
   * case the acquire/reuse guard protects against. */
  residentGemma?: boolean;
  /** After a fresh load, listModels reports a JIT sibling instance of the same
   * key (`<key>` + `<key>:1`) alongside the one we loaded — LM Studio's JIT
   * spawns its own copy while a workload holds an explicit load. Exercises the
   * key-wide teardown that must evict the sibling on dynamic profiles. */
  jitDuplicate?: boolean;
  /** dynamic_model value on the created profile (default true). false models a
   * user who preconfigures resident models and must never have them torn down. */
  dynamicModel?: boolean;
  /** POST /models/download fails with HTTP 500. */
  downloadFail?: boolean;
  /** GET /models/download/status fails with HTTP 500. */
  statusFail?: boolean;
  /** Registry entries seeded after profile creation (for diff/sweep tests). */
  registry?: RegistryEntry[];
  loadFailure?: boolean;
  chatDelayMs?: number;
  chatFail?: boolean;
}

export interface DownloadHarness {
  deps: ToolDeps;
  mock: MockLmStudio;
  counts: { downloads: number; statusPolls: number; loads: number; unloads: number; chats: number };
  lastDownloadBody: unknown;
  /** Snapshot of the mock's resident instances, keyed by model key. */
  loaded(): Record<string, string[]>;
  wait(source: string, opts?: Partial<DownloadWaitOptions>): Promise<DownloadWaitResult>;
  test(source: string, opts?: Partial<DownloadWaitOptions>): Promise<DownloadAndTestResult>;
  sweep(): Promise<SweepResult>;
  close(): Promise<void>;
}

export async function createDownloadHarness(opts: DownloadHarnessOptions = {}): Promise<DownloadHarness> {
  const home = scratchHome();
  const deps = buildDeps(home);
  const counts = { downloads: 0, statusPolls: 0, loads: 0, unloads: 0, chats: 0 };
  const state: { lastDownloadBody: unknown; loaded: Record<string, string[]> } = {
    lastDownloadBody: null,
    loaded: {},
  };
  // The fixture's llm key + its resident instance id (used when residentGemma).
  const fixtureKey = (listModelsFixture.models.find((m) => m.type === "llm") ?? listModelsFixture.models[0]!).key;
  const fixtureId = listModelsFixture.models.find((m) => m.type === "llm")?.loaded_instances[0]?.id ?? fixtureKey;
  if (opts.residentGemma) state.loaded[fixtureKey] = [fixtureId];
  let statusIdx = 0;
  const statuses = opts.downloadStatuses ?? ["downloading", "downloading", "completed"];
  const replies = passAllReplies;

  const mock = await startMockLmStudio(async (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? "/", "http://mock");
    switch (url.pathname) {
      case "/api/v1/models": {
        // Fixture catalog + live resident state. Keys the mock has loaded but
        // that aren't in the fixture (e.g. the OTHER regimen target) are added
        // as minimal entries so key-wide teardown can see them.
        const fx = structuredClone(listModelsFixture) as typeof listModelsFixture;
        const present = new Set(fx.models.map((m) => m.key));
        for (const m of fx.models) {
          m.loaded_instances = (state.loaded[m.key] ?? []).map((id) => ({ id, config: { context_length: 32768 } }));
        }
        for (const [key, ids] of Object.entries(state.loaded)) {
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
      case "/api/v1/models/load": {
        counts.loads++;
        if (opts.loadFailure) return sendJson(res, 500, { error: "load failed" });
        const parsed = JSON.parse(body) as { model?: string };
        const key = parsed.model ?? "";
        const ids = opts.jitDuplicate ? [key, `${key}:1`] : [key];
        state.loaded[key] = ids;
        return sendJson(res, 200, { ...loadModelFixture, instance_id: key });
      }
      case "/api/v1/models/unload": {
        counts.unloads++;
        const parsed = JSON.parse(body) as { instance_id?: string };
        const id = parsed.instance_id ?? "";
        for (const k of Object.keys(state.loaded)) {
          state.loaded[k] = state.loaded[k]!.filter((x) => x !== id);
          if (state.loaded[k]!.length === 0) delete state.loaded[k];
        }
        return sendJson(res, 200, unloadModelFixture);
      }
      case "/api/v1/models/download":
        counts.downloads++;
        state.lastDownloadBody = JSON.parse(body);
        if (opts.downloadFail) return sendJson(res, 500, { error: "download failed" });
        if (opts.alreadyDownloaded) return sendJson(res, 200, { status: "already_downloaded" });
        return sendJson(res, 200, { job_id: JOB_ID, status: "downloading", started_at: "2025-10-03T15:33:23.496Z" });
      case `/api/v1/models/download/status/${JOB_ID}`:
        counts.statusPolls++;
        if (opts.statusFail) return sendJson(res, 500, { error: "status failed" });
        const status = statuses[Math.min(statusIdx, statuses.length - 1)]!;
        statusIdx++;
        return sendJson(res, 200, { job_id: JOB_ID, status, started_at: "2025-10-03T15:33:23.496Z" });
      case "/api/v1/chat": {
        counts.chats++;
        if (opts.chatFail) return sendJson(res, 500, { error: "chat failed" });
        if (opts.chatDelayMs) await new Promise((r) => setTimeout(r, opts.chatDelayMs));
        const parsed = JSON.parse(body) as { input?: unknown };
        const prompt = typeof parsed.input === "string" ? parsed.input : String((parsed.input as { content: string }[])?.[0]?.content ?? "");
        const response = { ...chatResponseFixture, output: [{ type: "message", content: replies(prompt) }] };
        return wantsStream(body) ? sendChatStream(res, response) : sendJson(res, 200, response);
      }
      default:
        return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
    }
  });

  deps.profiles.createProfile({
    name: "t",
    endpoint: { url: mock.url },
    machine_specs: { vram_gb: 4 },
    dynamic_model: opts.dynamicModel ?? true,
  });
  for (const entry of opts.registry ?? []) deps.registry.upsert("t", entry);

  const fast = { sleep: async () => {} };

  return {
    deps,
    mock,
    counts,
    get lastDownloadBody(): unknown {
      return state.lastDownloadBody;
    },
    loaded: () => Object.fromEntries(Object.entries(state.loaded).map(([k, v]) => [k, [...v]])),
    wait: (source, o = {}) => downloadAndWait(deps, "t", source, { ...fast, ...o }),
    test: (source, o = {}) => downloadAndTest(deps, "t", source, { ...fast, ...o }),
    sweep: () => runUntestedSweep(deps, "t"),
    async close() {
      await mock.close().catch(() => {});
      deps.close();
      cleanup(home);
    },
  };
}
