/**
 * Phase 28 gate — Phase B generation-side idle timeouts. The kill signal is
 * IDLE (zero streamed events for the window), never elapsed time: a sub-agent
 * still emitting tokens past the old fixed budget is not cut off, a genuinely
 * stalled stream is, and a stalled regimen unit idles out with the model
 * unloaded exactly once. Driven through the phase8 sub-agent harness and the
 * phase7 regimen harness (both now answer `stream: true` chats over SSE, with
 * the new slow-but-alive / open-stall modes for these scenarios).
 */
import { describe, expect, it } from "vitest";
import { createSubAgentHarness } from "../phase8/helpers.js";
import { createRegimenHarness } from "../phase7/helpers.js";
import { LmErrorCodes } from "../../src/lmstudio/errors.js";

const OSS = "openai/gpt-oss-20b";

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject");
}

describe("Phase 28 gate — generation idle, not fixed budget", () => {
  it("slow-but-alive: a model emitting deltas past the old fixed budget is not killed", async () => {
    // Old behaviour: AbortSignal.timeout(clientTimeoutMs) killed at 250ms no
    // matter what. Now: deltas every ~50ms reset the idle timer, so a ~700ms
    // run sails past the old budget and completes (idle 150ms > 50ms cadence;
    // the 250ms budget survives only as a raised soft ceiling at 1000ms).
    const oldBudgetMs = 250;
    const h = await createSubAgentHarness({ chatSlow: { gapMs: 50, chunkCount: 14 } });
    const started = Date.now();
    const res = await h.runAgent({ model_id: OSS, clientTimeoutMs: oldBudgetMs, idle_timeout_ms: 150 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(oldBudgetMs);
    expect(res.reply).toContain("done");
    expect(res.unloaded).toBe(true);
    expect(h.counts.chats).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });

  it("stall: zero new tokens for > the idle window kills with generation_idle_timeout", async () => {
    const h = await createSubAgentHarness({ chatStall: true });
    const err = await rejection(() => h.runAgent({ model_id: OSS, idle_timeout_ms: 150 }));

    expect(err.message).toMatch(/stalled/i);
    expect((err as { code?: string }).code).toBe(LmErrorCodes.IDLE_TIMEOUT);
    // Teardown still runs exactly once on the idle-kill path.
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    expect(h.loaded.has(OSS)).toBe(false);
    await h.close();
  });

  it("regimen: a unit chat that stalls mid-run idles out and the model unloads exactly once", async () => {
    const h = await createRegimenHarness({ chatStall: true });
    await expect(h.runRegimen(OSS, { idle_timeout_ms: 150 })).rejects.toMatchObject({
      code: LmErrorCodes.IDLE_TIMEOUT,
    });
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });

  it("a fixed budget smaller than a pre-first-byte silence still times out (old contract preserved)", async () => {
    // The endpoint answers nothing for 300ms (whole response delayed). The
    // pre-first-event guard keeps the old fixed-budget semantics: an explicit
    // small timeout still fires promptly instead of waiting out the idle window.
    const h = await createSubAgentHarness({ chatDelayMs: 300 });
    const err = await rejection(() => h.runAgent({ model_id: OSS, clientTimeoutMs: 100 }));
    expect(err.message).toMatch(/timed out/i);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });
});
