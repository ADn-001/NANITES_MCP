/**
 * Phase 33 gate (Phase F, F2) — planner silent-fallback note. When model
 * discovery fails during run_sub_agent, context sizing plans against the 32768
 * default ceiling. That fallback must land in the planner's `note` so the
 * caller sees it instead of silently getting a misplanned budget.
 */
import { describe, expect, it } from "vitest";
import { planInference } from "../../src/helpers/inferencePlanner.js";

const BASE = {
  effort: "medium" as const,
  role: "reviewer",
  reasoningType: "unknown" as const,
  promptTokens: 100,
  outputTokenCeiling: 8192,
  maxContextLength: 32768,
};

describe("Phase 33 gate — discovery-fallback note (F2)", () => {
  it("an unknown context ceiling sets a note naming the default", () => {
    const p = planInference({ ...BASE, unknownContextCeiling: true });
    expect(p.note).toMatch(/ceiling unknowable/);
    expect(p.note).toMatch(/32768/);
  });

  it("a known ceiling stays silent (no note from this path)", () => {
    const p = planInference(BASE);
    expect(p.note).toBeUndefined();
  });

  it("the fallback note composes with an existing planner note", () => {
    // A non-reasoning model at reviewer/medium effort already gets a
    // reasoning-skip note; the discovery fallback joins it rather than
    // replacing it.
    const p = planInference({ ...BASE, reasoningType: "non_reasoning", unknownContextCeiling: true });
    expect(p.note).toMatch(/reasoning skipped/);
    expect(p.note).toMatch(/ceiling unknowable/);
  });
});
