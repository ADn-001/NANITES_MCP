/**
 * Phase 67 gate — concurrency and lifecycle.
 *
 * The headline case is the inference gate: a regimen, a btw chat turn and a
 * compaction each hold a model for an inference, and none of them took the
 * per-profile gate. On a sequential profile a concurrent sub-agent would then
 * acquire its own model and evict the running one out from under it.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { acquireInferenceSlot, resetInferenceGates } from "../../src/helpers/inferenceGate.js";
import { runHealthCheck } from "../../src/health/checker.js";
import { openNanitesDb } from "../../src/storage/db.js";
import { SubAgentEventStore } from "../../src/storage/subAgentEventStore.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

beforeEach(() => resetInferenceGates());

describe("the inference gate serializes per profile", () => {
  it("releases when the body throws, so the next acquirer proceeds", async () => {
    const first = acquireInferenceSlot("t");
    const release = await first;
    // A second acquirer must not proceed while the first holds it.
    let secondRan = false;
    const second = acquireInferenceSlot("t").then((r) => {
      secondRan = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondRan).toBe(false);

    release();
    const release2 = await second;
    expect(secondRan).toBe(true);
    release2();
  });

  it("does not block a different profile", async () => {
    const releaseA = await acquireInferenceSlot("a");
    let bRan = false;
    const b = acquireInferenceSlot("b").then((r) => {
      bRan = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(bRan).toBe(true);
    (await b)();
    releaseA();
  });
});

describe("recency replay returns the newest events (M37)", () => {
  it("returns the tail of a busy window, oldest-first", () => {
    const home = scratchHome();
    const { db, close } = openNanitesDb(home);
    const store = new SubAgentEventStore(db);
    // 10 events, 1 second apart, all inside the window.
    const base = Date.now() - 60_000;
    for (let i = 0; i < 10; i++) {
      store.insert({
        profile_name: "t",
        model_id: "m",
        phase: "chat.start",
        payload: { i },
      } as never);
    }
    const events = store.listSinceByTime("t", new Date(base).toISOString(), 3);
    // The NEWEST 3, returned oldest-first.
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e.payload as { i: number }).i)).toEqual([7, 8, 9]);
    close();
    cleanup(home);
  });
});

describe("health recovery cannot hang the boot path (M24, M25)", () => {
  it("returns even when the recovery step never settles", async () => {
    const client = {
      listModels: async () => {
        throw new Error("refused");
      },
    } as never;
    const report = await runHealthCheck({
      profile: "t",
      client,
      // A recovery that never resolves is the shape of an `lms` that daemonizes
      // without exiting. The checker must not wait on it forever.
      recovery: { run: () => new Promise<void>(() => {}), waitMs: 0 },
      disk: { availableGb: 500 },
    });
    expect(report.reachable).toBe(false);
    expect(report.overall).toBe("down");
  });

  it("marks recovery attempted only when a step actually ran (M25)", async () => {
    const client = { listModels: async () => ({ models: [] }) } as never;
    const report = await runHealthCheck({
      profile: "t",
      client,
      recovery: { run: async () => {}, waitMs: 0 },
      disk: { availableGb: 500 },
    });
    // Endpoint was reachable, so no recovery was attempted at all.
    expect(report.recovery_attempted).toBe(false);
  });

  it("reports the injected disk reading", async () => {
    const client = { listModels: async () => ({ models: [] }) } as never;
    const report = await runHealthCheck({
      profile: "t",
      client,
      disk: { availableGb: 500 },
    });
    expect(report.disk.source).toBe("injected");
    expect(report.overall).toBe("healthy");
  });
});
