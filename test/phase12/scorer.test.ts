import { describe, expect, it } from "vitest";
import { scoreRuns, NEUTRAL_SCORE } from "../../src/helpers/performanceScorer.js";
import type { CallLogEntry } from "../../src/storage/callLogStore.js";

function run(partial: Partial<CallLogEntry> = {}): CallLogEntry {
  return {
    profile_name: "t",
    model_id: "m",
    tokens_in: 0,
    tokens_out: 0,
    duration_ms: 1000,
    ...partial,
  };
}

describe("performanceScorer.scoreRuns", () => {
  it("empty input -> neutral 50", () => {
    expect(scoreRuns([])).toBe(NEUTRAL_SCORE);
  });

  it("perfect run -> 100", () => {
    const perfect = run({
      tokens_in: 20,
      tokens_out: 20,
      duration_ms: 1000, // 40 t/s
      ttft_ms: 0,
      error_code: null,
      context_window: 32768,
    });
    expect(scoreRuns([perfect])).toBe(100);
  });

  it("all-error runs -> 1", () => {
    const err = run({ tokens_in: 0, tokens_out: 0, duration_ms: 1000, error_code: "chat_failed", ttft_ms: null, context_window: null });
    expect(scoreRuns([err, err, err])).toBe(1);
  });

  it("small context applies ctx_penalty vs full context", () => {
    const base = { tokens_in: 20, tokens_out: 20, duration_ms: 1000, ttft_ms: 0, error_code: null };
    expect(scoreRuns([run({ ...base, context_window: 4096 })])).toBeLessThan(
      scoreRuns([run({ ...base, context_window: 32768 })]),
    );
  });

  it("slow run scores lower than fast", () => {
    const slow = run({ tokens_in: 4, tokens_out: 4, duration_ms: 2000, ttft_ms: 0, error_code: null, context_window: 32768 });
    const fast = run({ tokens_in: 40, tokens_out: 40, duration_ms: 2000, ttft_ms: 0, error_code: null, context_window: 32768 });
    expect(scoreRuns([slow])).toBeLessThan(scoreRuns([fast]));
  });

  it("clamps to [1,100]", () => {
    const awful = run({ tokens_in: 0, tokens_out: 0, duration_ms: 1, ttft_ms: 10000, error_code: "x", context_window: 0 });
    const s = scoreRuns([awful]);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(100);
  });
});
