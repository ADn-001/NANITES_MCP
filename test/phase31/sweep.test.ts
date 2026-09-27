/**
 * Phase 31 (E gate) — item 7: sweep reorder + resilience (E-req). The untested
 * sweep discovers models ascending by size_bytes (fail-fast on the affordable
 * models first) and wraps each model's regimen so one failure records
 * {model_id, error} and the sweep continues instead of losing all progress.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { runUntestedSweep } from "../../src/workflows/runUntestedSweep.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { sendChatStream, sendJson, startMockLmStudio, wantsStream, type MockLmStudio } from "../phase1/mockServer.js";
import { chatResponseFixture, unloadModelFixture } from "../phase1/fixtures.js";
import { detUnit } from "./helpers.js";

// Ascending by size_bytes: the failing model is the smallest so a sweep that
// aborted on the first failure would produce zero summaries.
const CATALOG = [
  { key: "tiny/fail", size: 100_000_000, failsLoad: true },
  { key: "med/ok", size: 200_000_000, failsLoad: false },
  { key: "big/ok", size: 300_000_000, failsLoad: false },
];

function modelShape(key: string, size: number): Record<string, unknown> {
  return {
    type: "llm",
    publisher: "mock",
    key,
    display_name: key,
    quantization: { name: "Q4_0", bits_per_weight: 4 },
    size_bytes: size,
    params_string: null,
    loaded_instances: [],
    max_context_length: 4096,
    format: "gguf",
  };
}

describe("Phase 31 — untested sweep: ascending size + per-model resilience", () => {
  let deps: ToolDeps;
  let mock: MockLmStudio;
  let home: string;

  afterEach(async () => {
    await mock.close().catch(() => {});
    deps.close();
    cleanup(home);
  });

  it("sorts candidates ascending by size_bytes and records a failing model without aborting", async () => {
    home = scratchHome();
    deps = buildDeps(home);

    mock = await startMockLmStudio(async (req: IncomingMessage, res: ServerResponse, body: string) => {
      const url = new URL(req.url ?? "/", "http://mock");
      switch (url.pathname) {
        case "/api/v1/models":
          return sendJson(res, 200, { models: CATALOG.map((c) => modelShape(c.key, c.size)) });
        case "/api/v1/models/load": {
          const parsed = JSON.parse(body) as { model?: string };
          const model = CATALOG.find((c) => c.key === parsed.model);
          if (model?.failsLoad) return sendJson(res, 500, { error: `failed to load ${parsed.model}` });
          return sendJson(res, 200, { type: "llm", instance_id: parsed.model, load_time_seconds: 0.1, status: "loaded" });
        }
        case "/api/v1/models/unload":
          return sendJson(res, 200, unloadModelFixture);
        case "/api/v1/chat": {
          const parsed = JSON.parse(body) as { input?: unknown };
          const prompt = typeof parsed.input === "string" ? parsed.input : String((parsed.input as { content: string }[])?.[0]?.content ?? "");
          const reply = prompt.includes("export my data") ? "QUESTION" : "ok";
          const response = { ...chatResponseFixture, output: [{ type: "message", content: reply }] };
          if (!wantsStream(body)) return sendJson(res, 200, response);
          return sendChatStream(res, response as unknown as Record<string, unknown>);
        }
        default:
          return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
      }
    });

    // One deterministic unit so each swept model's regimen finalizes fast
    // instead of registering the 29-unit default.
    deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url }, machine_specs: { vram_gb: 4 } });
    deps.testUnits.register("t", detUnit({ id: "sweep-det" }));

    const result = await runUntestedSweep(deps, "t");

    // Order is ascending by size_bytes: the failing smallest model comes first.
    expect(result.models).toEqual(["tiny/fail", "med/ok", "big/ok"]);

    // The failing model is recorded, not fatal — the sweep continued to the rest.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.model_id).toBe("tiny/fail");
    expect(typeof result.failures[0]!.error.code).toBe("string");
    expect(typeof result.failures[0]!.error.message).toBe("string");

    // Both surviving models ran and finalized their registry entries.
    expect(result.summaries.map((s) => s.model_id)).toEqual(["med/ok", "big/ok"]);
    expect(result.untested_count).toBe(3);
    expect(deps.registry.get("t", "med/ok")).not.toBeNull();
    expect(deps.registry.get("t", "big/ok")).not.toBeNull();
    expect(deps.registry.get("t", "tiny/fail")).toBeNull();
  });
});
