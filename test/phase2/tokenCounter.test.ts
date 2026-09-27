import { describe, expect, it } from "vitest";
import { countTokens, usageEstimate, usageFromStats } from "../../src/helpers/tokenCounter.js";

describe("tokenCounter", () => {
  it("estimates ~4 chars per token, minimum 1", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("abcd")).toBe(1);
    expect(countTokens("a")).toBe(1);
    expect(countTokens("x".repeat(100))).toBe(25);
  });

  it("prefers authoritative stats when present", () => {
    const usage = usageFromStats({ input_tokens: 17, total_output_tokens: 50, reasoning_output_tokens: 3, tokens_per_second: 51, time_to_first_token_seconds: 0.8 });
    expect(usage).toEqual({ inputTokens: 17, outputTokens: 50, reasoningTokens: 3 });
  });

  it("falls back to estimates for a call that never reached the API", () => {
    const usage = usageEstimate(["a".repeat(40)], "b".repeat(20));
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    expect(usage.reasoningTokens).toBe(0);
  });
});
