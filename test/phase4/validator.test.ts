import { describe, expect, it } from "vitest";
import { validateTestUnit, type ValidationIssue } from "../../src/testunits/validator.js";
import type { TestUnit } from "../../src/testunits/schema.js";

function validUnit(): TestUnit {
  return {
    id: "u1",
    name: "Sample",
    task_group: "task1",
    difficulty: "easy",
    prompts: [{ id: "a", text: "Do the thing." }],
    measures: ["quality"],
    applicable_roles: ["code_qa"],
    recommended_config: {
      context_length: 8000,
      kv_cache_quant: "Q8",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.1,
      max_output_tokens: 400,
    },
    scoring: { method: "orchestrator_judged", rubric: "Correctness matters; honesty matters; conciseness matters." },
    source: "custom_authored",
    version: 1,
  };
}

function issuesOf(mutator: (u: TestUnit) => void, existingIds: string[] = []): ValidationIssue[] {
  const unit = validUnit();
  mutator(unit);
  return validateTestUnit(unit, existingIds).issues;
}

describe("validateTestUnit — rejects one deliberately broken unit per rule", () => {
  it("missing rubric on orchestrator_judged", () => {
    const issues = issuesOf((u) => {
      u.scoring.method = "orchestrator_judged";
      delete u.scoring.rubric;
    });
    expect(issues.some((i) => i.field === "scoring.rubric")).toBe(true);
  });

  it("whitespace-only rubric is also rejected", () => {
    const issues = issuesOf((u) => {
      u.scoring.rubric = "   \n  ";
    });
    expect(issues.some((i) => i.field === "scoring.rubric")).toBe(true);
  });

  it("empty prompts array", () => {
    const issues = issuesOf((u) => {
      u.prompts = [];
    });
    expect(issues.some((i) => i.field === "prompts")).toBe(true);
  });

  it("duplicate unit id within the registered set", () => {
    const issues = issuesOf(() => {}, ["u1"]);
    expect(issues.some((i) => i.field === "id" && /duplicate id/.test(i.message))).toBe(true);
  });

  it("duplicate prompt id within a unit", () => {
    const issues = issuesOf((u) => {
      u.prompts = [
        { id: "a", text: "one" },
        { id: "a", text: "two" },
      ];
    });
    expect(issues.some((i) => i.field === "prompts[1].id" && /duplicate prompt id/.test(i.message))).toBe(true);
  });

  it("out-of-range config values (negative temperature, zero max tokens, top_p > 1, top_k 0)", () => {
    for (const [mutator, field] of [
      [(u: TestUnit) => { u.recommended_config.temperature = -0.5; }, "recommended_config.temperature"],
      [(u: TestUnit) => { u.recommended_config.temperature = 3; }, "recommended_config.temperature"],
      [(u: TestUnit) => { u.recommended_config.max_output_tokens = 0; }, "recommended_config.max_output_tokens"],
      [(u: TestUnit) => { u.recommended_config.top_p = 1.5; }, "recommended_config.top_p"],
      [(u: TestUnit) => { u.recommended_config.top_k = 0; }, "recommended_config.top_k"],
      [(u: TestUnit) => { u.recommended_config.context_length = 10; }, "recommended_config.context_length"],
      [(u: TestUnit) => { u.recommended_config.kv_cache_quant = "FP16"; }, "recommended_config.kv_cache_quant"],
    ] as Array<[(u: TestUnit) => void, string]>) {
      const issues = issuesOf(mutator);
      expect(issues.some((i) => i.field === field), field).toBe(true);
    }
  });

  it("deterministic_rule with no rule", () => {
    const issues = issuesOf((u) => {
      u.scoring.method = "deterministic_rule";
      delete u.scoring.rule;
    });
    expect(issues.some((i) => i.field === "scoring.rule")).toBe(true);
  });

  it("exact_match missing params.expected", () => {
    const issues = issuesOf((u) => {
      u.scoring = { method: "deterministic_rule", rule: { type: "exact_match", params: {} } };
    });
    expect(issues.some((i) => i.field === "scoring.rule.params.expected")).toBe(true);
  });

  it("label_in_set missing params.set", () => {
    const issues = issuesOf((u) => {
      u.scoring = { method: "deterministic_rule", rule: { type: "label_in_set", params: { set: [] } } };
    });
    expect(issues.some((i) => i.field === "scoring.rule.params.set")).toBe(true);
  });

  it("regex_match with an invalid pattern", () => {
    const issues = issuesOf((u) => {
      u.scoring = { method: "deterministic_rule", rule: { type: "regex_match", params: { pattern: "[" } } };
    });
    expect(issues.some((i) => i.field === "scoring.rule.params.pattern")).toBe(true);
  });

  it("unknown scoring rule type", () => {
    const issues = issuesOf((u) => {
      u.scoring = { method: "deterministic_rule", rule: { type: "contains" as never, params: {} } };
    });
    expect(issues.some((i) => i.field === "scoring.rule.type")).toBe(true);
  });

  it("unknown measure and empty applicable_roles", () => {
    const issues = issuesOf((u) => {
      u.measures = ["creativity" as never];
      u.applicable_roles = [];
    });
    expect(issues.some((i) => i.field === "measures" && /unknown measure/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.field === "applicable_roles")).toBe(true);
  });

  it("unknown difficulty and bad version", () => {
    const issues = issuesOf((u) => {
      u.difficulty = "expert" as never;
      u.version = 0;
    });
    expect(issues.some((i) => i.field === "difficulty")).toBe(true);
    expect(issues.some((i) => i.field === "version")).toBe(true);
  });

  it("a fully valid unit passes with zero issues", () => {
    const result = validateTestUnit(validUnit());
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
