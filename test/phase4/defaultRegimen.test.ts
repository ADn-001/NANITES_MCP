import { describe, expect, it } from "vitest";
import { DEFAULT_REGIMEN, DEFAULT_TEST_PLAN_REF } from "../../src/testunits/defaultRegimen.js";
import { validateTestUnit } from "../../src/testunits/validator.js";
import type { TestUnit } from "../../src/testunits/schema.js";

describe("default regimen — every unit validates with zero errors (gate 1)", () => {
  // Faithful to the draft: Tasks 1-9 have three prompts (a/b/c), Task 10 has
  // two (10a/10b) — 29 units across 10 task groups.
  it("has the expected shape: 29 units across 10 task groups, unique ids", () => {
    expect(DEFAULT_REGIMEN).toHaveLength(29);
    expect(new Set(DEFAULT_REGIMEN.map((u) => u.id)).size).toBe(29);
    const groups = new Set(DEFAULT_REGIMEN.map((u) => u.task_group));
    expect(groups.size).toBe(10);
    for (const unit of DEFAULT_REGIMEN) {
      expect(unit.source).toBe("default_regimen");
      expect(unit.version).toBe(1);
    }
  });

  it("passes validate_test_unit for every unit with zero issues", () => {
    for (const unit of DEFAULT_REGIMEN) {
      const result = validateTestUnit(unit, []);
      expect(result.ok, `${unit.id}: ${JSON.stringify(result.issues)}`).toBe(true);
      expect(result.issues).toHaveLength(0);
    }
  });

  it("every unit has exactly the one prompt from the draft", () => {
    for (const unit of DEFAULT_REGIMEN) {
      expect(unit.prompts).toHaveLength(1);
      expect(unit.prompts[0]!.text.trim().length).toBeGreaterThan(20);
    }
  });

  it("orchestrator_judged units carry a non-trivial rubric; deterministic units carry a valid rule", () => {
    for (const unit of DEFAULT_REGIMEN) {
      if (unit.scoring.method === "orchestrator_judged") {
        expect(unit.scoring.rubric!.trim().length).toBeGreaterThanOrEqual(10);
      } else {
        expect(unit.scoring.rule).toBeTruthy();
        expect(["json_valid", "exact_match", "label_in_set", "regex_match"]).toContain(unit.scoring.rule!.type);
      }
    }
  });

  it("DEFAULT_TEST_PLAN_REF is 'default'", () => {
    expect(DEFAULT_TEST_PLAN_REF).toBe("default");
  });
});

describe("default regimen — spot-check per task group (gate 3)", () => {
  // One unit per task group (the easy one): prompt text unchanged, scoring
  // method correct, rubric traceable to the draft's rubric bullets.
  const byGroup = new Map<string, TestUnit>();
  for (const u of DEFAULT_REGIMEN) {
    if (u.difficulty === "easy") byGroup.set(u.task_group, u);
  }

  it("task1_codebase_qa — orchestrator_judged, rubric has draft's Correctness/Honesty bullets", () => {
    const unit = byGroup.get("task1_codebase_qa")!;
    expect(unit.prompts[0]!.text).toContain("Summarize what this file does in 3-5 sentences");
    expect(unit.scoring.method).toBe("orchestrator_judged");
    expect(unit.scoring.rubric).toContain("Correctness");
    expect(unit.scoring.rubric).toContain("Honesty");
  });

  it("task2_extraction — deterministic json_valid, prompt unchanged", () => {
    const unit = byGroup.get("task2_extraction")!;
    expect(unit.prompts[0]!.text).toContain('Extract the following fields from this commit message as JSON');
    expect(unit.scoring.method).toBe("deterministic_rule");
    expect(unit.scoring.rule!.type).toBe("json_valid");
  });

  it("task3_unit_test_gen — orchestrator_judged, rubric mentions boundary test for 3c", () => {
    const unit = byGroup.get("task3_unit_test_gen")!;
    expect(unit.prompts[0]!.text).toContain("Write unit tests (using vitest/jest syntax)");
    expect(unit.scoring.method).toBe("orchestrator_judged");
    expect(unit.scoring.rubric).toContain("boundary-testing");
  });

  it("task4_boilerplate — orchestrator_judged, prompt unchanged", () => {
    const unit = byGroup.get("task4_boilerplate")!;
    expect(unit.prompts[0]!.text).toContain('Generate a TypeScript interface named "UserProfile"');
    expect(unit.scoring.method).toBe("orchestrator_judged");
  });

  it("task5_commit_msg — orchestrator_judged, rubric mentions conventional commit", () => {
    const unit = byGroup.get("task5_commit_msg")!;
    expect(unit.prompts[0]!.text).toContain("conventional-commit style message");
    expect(unit.scoring.method).toBe("orchestrator_judged");
    expect(unit.scoring.rubric).toContain("Format compliance");
  });

  it("task6_code_review — orchestrator_judged, rubric carries the 6c false-positive critical test", () => {
    const unit = byGroup.get("task6_code_review")!;
    expect(unit.prompts[0]!.text).toContain("Review this code for bugs");
    expect(unit.scoring.method).toBe("orchestrator_judged");
    expect(unit.scoring.rubric).toContain("6c");
  });

  it("task7_classification — deterministic, exact labels for 7a/7b, label_in_set for 7c", () => {
    const easy = byGroup.get("task7_classification")!;
    expect(easy.prompts[0]!.text).toContain("Classify as exactly one of: BUG, FEATURE, QUESTION, OTHER");
    expect(easy.scoring.method).toBe("deterministic_rule");
    expect(easy.scoring.rule!.type).toBe("exact_match");
    const hard = DEFAULT_REGIMEN.find((u) => u.id === "task7-classify-hard")!;
    expect(hard.scoring.rule!.type).toBe("label_in_set");
  });

  it("task8_docs — orchestrator_judged, 8b notes the edge case", () => {
    const unit = byGroup.get("task8_docs")!;
    expect(unit.prompts[0]!.text).toContain("Add a JSDoc comment");
    expect(unit.scoring.method).toBe("orchestrator_judged");
    const medium = DEFAULT_REGIMEN.find((u) => u.id === "task8-docs-medium")!;
    expect(medium.prompts[0]!.notes).toContain("min > max");
  });

  it("task9_refactor — orchestrator_judged, 9c notes restraint requirement", () => {
    const unit = byGroup.get("task9_refactor")!;
    expect(unit.prompts[0]!.text).toContain("Convert this to use async/await");
    expect(unit.scoring.method).toBe("orchestrator_judged");
    const hard = DEFAULT_REGIMEN.find((u) => u.id === "task9-refactor-hard")!;
    expect(hard.prompts[0]!.notes).toContain("Rename only d");
  });

  it("task10_format_compliance — deterministic exact_match, 10b expected NONE", () => {
    const easy = byGroup.get("task10_format_compliance")!;
    expect(easy.prompts[0]!.text).toContain("Answer with ONLY the number");
    expect(easy.scoring.method).toBe("deterministic_rule");
    expect(easy.scoring.rule!.type).toBe("exact_match");
    expect(easy.scoring.rule!.params.expected).toBe("7");
    const hard = DEFAULT_REGIMEN.find((u) => u.id === "task10-format-compliance-hard")!;
    expect(hard.scoring.rule!.params.expected).toBe("NONE");
  });

  it("every group's easy/medium/hard unit maps to draft difficulty correctly", () => {
    const levels: Record<string, string[]> = {
      easy: [], medium: [], hard: [],
    };
    for (const unit of DEFAULT_REGIMEN) levels[unit.difficulty]!.push(unit.id);
    expect(levels.easy).toHaveLength(10); // tasks 1-9 + task10's 10a
    expect(levels.medium).toHaveLength(9); // task 10 has no medium prompt
    expect(levels.hard).toHaveLength(10); // tasks 1-9 + task10's 10b
  });
});

// Typed export guard — the converted units really are TestUnits.
const _check: TestUnit[] = DEFAULT_REGIMEN;
void _check;
