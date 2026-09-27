/**
 * Phase 10 gate — use-case adaptation (items 2-4). The check fires only for
 * use cases that diverge from nanites-default, the yes-path routes authored
 * units through validate -> register (an invalid authored unit is rejected and
 * not registered, with issues surfaced), and the no-path exposes an explicit
 * "may not be well-calibrated" notice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { checkAdaptation, registerAdaptedUnits } from "../../src/workflows/adaptation.js";
import type { TestUnit } from "../../src/testunits/schema.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const validUnit: TestUnit = {
  id: "custom-1",
  name: "custom classifier unit",
  task_group: "custom",
  difficulty: "easy",
  prompts: [{ id: "p1", text: "Classify as exactly one of: BUG, FEATURE. Respond with only the label.\n\n\"export my data\"", expected: "FEATURE", notes: null }],
  measures: ["format_compliance"],
  applicable_roles: ["classifier"],
  recommended_config: { context_length: 2000, kv_cache_quant: "Q4", temperature: 0, top_p: 1, top_k: 1, repeat_penalty: 1, max_output_tokens: 10 },
  scoring: { method: "deterministic_rule", rule: { type: "exact_match", params: { expected: "FEATURE" } } },
  source: "custom_authored",
  version: 1,
};

describe("checkAdaptation", () => {
  it("does not trigger for nanites-default", () => {
    const res = checkAdaptation("nanites-default");
    expect(res.needs_adaptation).toBe(false);
    expect(res.prompt).toBeNull();
    expect(res.default_plan_notice).toBeNull();
  });

  it("triggers for any other use case, naming it in the prompt", () => {
    const res = checkAdaptation("customer-support");
    expect(res.needs_adaptation).toBe(true);
    expect(res.prompt).toMatch(/customer-support/);
    expect(res.default_plan_notice).toMatch(/may not be well-calibrated/);
  });
});

describe("registerAdaptedUnits", () => {
  let deps: ToolDeps;
  let home: string;

  beforeEach(() => {
    home = scratchHome();
    deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
  });
  afterEach(() => {
    deps.close();
    cleanup(home);
  });

  it("registers valid units and rejects invalid ones with surfaced issues", () => {
    const invalid = {
      ...validUnit,
      id: "custom-2",
      scoring: { method: "orchestrator_judged", rubric: "x" },
    };
    const res = registerAdaptedUnits(deps, "t", [validUnit, invalid]);
    expect(res.registered).toBe(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.id).toBe("custom-2");
    expect(res.rejected[0]!.issues.join("; ")).toMatch(/rubric/i);
    expect(deps.testUnits.list("t").map((u) => u.id)).toEqual(["custom-1"]);
  });

  it("duplicate ids within a batch are rejected, not double-registered", () => {
    const dup = { ...validUnit };
    const res = registerAdaptedUnits(deps, "t", [validUnit, dup]);
    expect(res.registered).toBe(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.issues.join("; ")).toMatch(/duplicate id/i);
  });
});
