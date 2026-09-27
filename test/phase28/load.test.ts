/**
 * Phase 28 gate — Phase B load-side idle heartbeat. LM Studio's `/models/load`
 * is a blocking POST with no progress events, so while it is in flight we poll
 * a cheap reachability signal and abort only on real silence. A slow load that
 * keeps answering is never cut off; an endpoint that goes silent is killed with
 * a structured error, never a partial execution. These are client-level tests
 * against a bare mock (NOT via acquireModel, whose initial listModels discovery
 * must succeed first).
 */
import { describe, expect, it } from "vitest";
import { LmStudioClient } from "../../src/lmstudio/client.js";
import { LmErrorCodes } from "../../src/lmstudio/errors.js";
import { startMockLmStudio, sendJson } from "../phase1/mockServer.js";
import {
  GENERATION_IDLE_TIMEOUT_MS,
  LOAD_HEARTBEAT_IDLE_MS,
  LOAD_HEARTBEAT_INTERVAL_MS,
  SOFT_CEILING_MULT,
} from "../../src/helpers/idleTimeout.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject");
}

describe("Phase 28 gate — load idle heartbeat", () => {
  it("a slow load that keeps answering heartbeats completes (not idle-killed)", async () => {
    // The heartbeat idle window (60ms) is SMALLER than the load's duration
    // (120ms), yet the load survives: heartbeats succeed every ~20ms, so there
    // is never a genuine silent stretch. A fixed 60ms wall-clock budget would
    // have cut this load off.
    let loadHits = 0;
    const mock = await startMockLmStudio(async (req, res, body) => {
      const url = new URL(req.url ?? "/", "http://mock");
      switch (url.pathname) {
        case "/api/v1/models":
          return sendJson(res, 200, { models: [] });
        case "/api/v1/models/load": {
          loadHits++;
          await sleep(120);
          return sendJson(res, 200, { instance_id: "i-1", status: "loaded", load_time_seconds: 0.12 });
        }
        default:
          return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
      }
    });

    const client = new LmStudioClient({ baseUrl: mock.url, timeoutMs: 5000 });
    const r = await client.loadModelWithHeartbeat(
      { model: "x" },
      { timeoutMs: 5000, heartbeatIntervalMs: 20, heartbeatIdleMs: 60 },
    );
    expect(r.instance_id).toBe("i-1");
    expect(loadHits).toBe(1);
    await mock.close();
  });

  it("an endpoint silent for > the idle window kills the load with load_idle_timeout", async () => {
    // The load POST hangs (never answered) AND the /models heartbeat starts
    // failing immediately. With a tiny heartbeat idle window the load is killed
    // as soon as the endpoint's silence exceeds it.
    const mock = await startMockLmStudio(async (req, res, body) => {
      const url = new URL(req.url ?? "/", "http://mock");
      switch (url.pathname) {
        case "/api/v1/models":
          return sendJson(res, 500, { error: "down" });
        case "/api/v1/models/load":
          // Deliberately never respond — a hung load.
          return;
        default:
          return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
      }
    });

    const client = new LmStudioClient({ baseUrl: mock.url, timeoutMs: 10_000 });
    const err = await rejection(() =>
      client.loadModelWithHeartbeat({ model: "x" }, { timeoutMs: 10_000, heartbeatIntervalMs: 15, heartbeatIdleMs: 80 }),
    );
    expect((err as { code?: string }).code).toBe(LmErrorCodes.LOAD_IDLE_TIMEOUT);
    expect(err.message).toMatch(/stalled/i);
    await mock.close();
  });

  it("locked defaults: idle generation window, load heartbeat cadence, soft ceiling", () => {
    expect(GENERATION_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(LOAD_HEARTBEAT_INTERVAL_MS).toBe(2_000);
    expect(LOAD_HEARTBEAT_IDLE_MS).toBe(30_000);
    expect(SOFT_CEILING_MULT).toBe(4);
  });
});
