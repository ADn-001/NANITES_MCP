import { describe, expect, it } from "vitest";
import {
  planInference,
  seedReasoningType,
  EFFORT_FRACTION,
  GEN_TIMEOUT_CEIL_MS,
  GEN_TIMEOUT_FLOOR_MS,
  type PlanInferenceInput,
} from "../../src/helpers/inferencePlanner.js";

const CEILING = 8192;
const MAX_CTX = 32768;

function plan(over: Partial<PlanInferenceInput> = {}) {
  return planInference({
    effort: "medium",
    role: "summarizer",
    reasoningType: "non_reasoning",
    promptTokens: 500,
    outputTokenCeiling: CEILING,
    maxContextLength: MAX_CTX,
    ...over,
  });
}

describe("planInference — effort -> token budget fractions", () => {
  it("low/medium/high map to 1/8, 1/2, 1 of the ceiling (1024/4096/8192 at ceiling 8192)", () => {
    expect(plan({ effort: "low" }).max_output_tokens).toBe(1024);
    expect(plan({ effort: "medium" }).max_output_tokens).toBe(4096);
    expect(plan({ effort: "high" }).max_output_tokens).toBe(8192);
  });

  it("budget is rounded to a whole token and floored at 1", () => {
    // ceiling 1, low fraction = 1/8 -> round(0.125) = 0 -> floored to 1.
    expect(
      planInference({ effort: "low", role: "", reasoningType: "non_reasoning", promptTokens: 0, outputTokenCeiling: 1, maxContextLength: 32768 })
        .max_output_tokens,
    ).toBe(1);
  });

  it("EFFORT_FRACTION is exact for the three effort levels", () => {
    expect(EFFORT_FRACTION.low).toBeCloseTo(1 / 8);
    expect(EFFORT_FRACTION.medium).toBeCloseTo(1 / 2);
    expect(EFFORT_FRACTION.high).toBe(1);
  });
});

describe("planInference — reasoning flag matrix", () => {
  it("low effort suppresses thinking ('off') on reasoning-capable models so the budget yields an answer", () => {
    expect(plan({ effort: "low", role: "code_writer", reasoningType: "reasoning" }).reasoning).toBe("off");
    expect(plan({ effort: "low", role: "reviewer", reasoningType: "unknown" }).reasoning).toBe("off");
  });

  it("low effort omits the flag entirely for a known non-reasoning model", () => {
    expect(plan({ effort: "low", role: "code_writer", reasoningType: "non_reasoning" }).reasoning).toBeUndefined();
  });

  it("medium effort reasons only for difficult roles on a reasoning model", () => {
    expect(plan({ effort: "medium", role: "code_writer", reasoningType: "reasoning" }).reasoning).toBe("on");
    expect(plan({ effort: "medium", role: "summarizer", reasoningType: "reasoning" }).reasoning).toBeUndefined();
  });

  it("high effort reasons for every role on a reasoning model", () => {
    expect(plan({ effort: "high", role: "summarizer", reasoningType: "reasoning" }).reasoning).toBe("on");
    expect(plan({ effort: "high", role: "", reasoningType: "reasoning" }).reasoning).toBe("on");
  });

  it("unknown reasoning type is treated like reasoning-capable (best-effort on)", () => {
    expect(plan({ effort: "high", role: "summarizer", reasoningType: "unknown" }).reasoning).toBe("on");
  });

  it("never sends reasoning to a known non-reasoning model; adds a note instead", () => {
    const p = plan({ effort: "high", role: "code_writer", reasoningType: "non_reasoning" });
    expect(p.reasoning).toBeUndefined();
    expect(p.note).toContain("reasoning skipped");
  });

  it("no note on a normal reasoning path", () => {
    expect(plan({ effort: "high", role: "code_writer", reasoningType: "reasoning" }).note).toBeUndefined();
  });
});

describe("planInference — context length", () => {
  it("reserves input + output budget + reasoning headroom + padding", () => {
    const p = plan({ effort: "high", reasoningType: "reasoning", promptTokens: 500 });
    // 500 + 8192 + 2048 + 1024 = 11764 -> round up to 11776
    expect(p.context_length).toBe(11776);
  });

  it("rounds up to a 512 multiple", () => {
    expect(plan({ promptTokens: 1, effort: "low" }).context_length % 512).toBe(0);
  });

  it("clamps to the model's max context length", () => {
    const p = plan({ effort: "high", reasoningType: "reasoning", promptTokens: 50000, maxContextLength: 4096 });
    expect(p.context_length).toBe(4096);
  });

  it("minimum context for low effort is the budget + padding", () => {
    // 0 prompt + 1024 budget + 0 headroom + 1024 padding = 2048 (already a 512 multiple).
    expect(plan({ promptTokens: 0, effort: "low" }).context_length).toBe(2048);
  });
});

describe("planInference — generation timeout", () => {
  it("low effort, non-reasoning model: base + output-time, no reasoning multiplier", () => {
    const p = plan({ effort: "low", reasoningType: "non_reasoning" });
    // base 20000 + (1024/40)*1000 = 25600 -> 45600 (above floor, stays)
    expect(p.generation_timeout_ms).toBe(45600);
    expect(p.generation_timeout_ms).toBeGreaterThanOrEqual(GEN_TIMEOUT_FLOOR_MS);
  });

  it("doubles the timeout for reasoning/unknown models", () => {
    const non = plan({ effort: "medium", reasoningType: "non_reasoning" }).generation_timeout_ms;
    const reason = plan({ effort: "medium", reasoningType: "reasoning" }).generation_timeout_ms;
    expect(reason).toBeGreaterThan(non);
  });

  it("clamps within [floor, ceil]", () => {
    expect(plan({ effort: "low" }).generation_timeout_ms).toBeGreaterThanOrEqual(GEN_TIMEOUT_FLOOR_MS);
    expect(plan({ effort: "high", reasoningType: "reasoning", promptTokens: 0 }).generation_timeout_ms).toBeLessThanOrEqual(
      GEN_TIMEOUT_CEIL_MS,
    );
  });
});

describe("seedReasoningType", () => {
  it("marks qwen3/qwen3.5 models as reasoning", () => {
    expect(seedReasoningType("qwen3.5-2b-it")).toBe("reasoning");
    expect(seedReasoningType("qwen3-8b")).toBe("reasoning");
  });

  it("does NOT mark bare deepseek (deepseek-coder-v2-lite is non-reasoning)", () => {
    expect(seedReasoningType("deepseek-coder-v2-lite-instruct")).toBe("unknown");
  });

  it("marks deepseek-r / deepseek-v4 reasoning variants", () => {
    expect(seedReasoningType("deepseek-r1-distill")).toBe("reasoning");
    expect(seedReasoningType("deepseek-v4")).toBe("reasoning");
  });

  it("returns unknown for non-reasoning names and is case-insensitive", () => {
    expect(seedReasoningType("gemma-3-270m")).toBe("unknown");
    expect(seedReasoningType("QWEN3-8B")).toBe("reasoning");
  });
});
