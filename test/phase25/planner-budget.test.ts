/**
 * Phase 16 Part C — planner-derived reasoning_budget. Emitted only when
 * reasoning is "on"; scaled by effort; explicit override wins; absent when
 * reasoning is off/omitted.
 */
import { describe, expect, it } from "vitest";
import { planInference, REASONING_BUDGET_MULT, type PlanInferenceInput } from "../../src/helpers/inferencePlanner.js";

const CEILING = 8192;

function plan(over: Partial<PlanInferenceInput> = {}) {
  return planInference({
    effort: "high",
    role: "code_writer",
    reasoningType: "reasoning",
    promptTokens: 0,
    outputTokenCeiling: CEILING,
    maxContextLength: 32768,
    ...over,
  });
}

describe("planInference — reasoning_budget", () => {
  it("scales the budget off the output budget by effort when reasoning is on", () => {
    const p = plan({ effort: "high", role: "code_writer" });
    expect(p.reasoning).toBe("on");
    expect(p.reasoning_budget).toBe(Math.round(8192 * REASONING_BUDGET_MULT.high));
  });

  it("medium difficult role gets its own budget", () => {
    const p = plan({ effort: "medium", role: "code_writer" });
    expect(p.reasoning).toBe("on");
    expect(p.reasoning_budget).toBe(Math.round(4096 * REASONING_BUDGET_MULT.medium));
  });

  it("omits the budget when reasoning is off (low effort)", () => {
    const p = plan({ effort: "low", role: "code_writer" });
    expect(p.reasoning).toBe("off");
    expect(p.reasoning_budget).toBeUndefined();
  });

  it("omits the budget for a known non-reasoning model", () => {
    const p = plan({ reasoningType: "non_reasoning", role: "code_writer" });
    expect(p.reasoning).toBeUndefined();
    expect(p.reasoning_budget).toBeUndefined();
  });

  it("omits the budget when effort doesn't ask for reasoning on an easy role", () => {
    const p = plan({ effort: "medium", role: "summarizer" });
    expect(p.reasoning).toBeUndefined();
    expect(p.reasoning_budget).toBeUndefined();
  });

  it("an explicit override wins over the derived budget", () => {
    const p = plan({ effort: "high", role: "code_writer", reasoningBudgetOverride: 250 });
    expect(p.reasoning).toBe("on");
    expect(p.reasoning_budget).toBe(250);
  });

  it("an override is ignored when reasoning is not on", () => {
    const p = plan({ effort: "low", reasoningBudgetOverride: 250 });
    expect(p.reasoning).toBe("off");
    expect(p.reasoning_budget).toBeUndefined();
  });
});
