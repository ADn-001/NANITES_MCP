import { describe, expect, it } from "vitest";
import { adviseGuardrails } from "../../src/guardrails/advisor.js";

interface Case {
  vramGb: number;
  tier: string;
  mode: "sequential" | "parallel";
  maxParallel: number;
}

// Boundary values at and around every threshold from §4.
const CASES: Case[] = [
  { vramGb: 3, tier: "baseline", mode: "sequential", maxParallel: 1 },
  { vramGb: 5, tier: "baseline", mode: "sequential", maxParallel: 1 },
  { vramGb: 6, tier: "mid", mode: "sequential", maxParallel: 1 },
  { vramGb: 11, tier: "mid", mode: "sequential", maxParallel: 1 },
  { vramGb: 12, tier: "high", mode: "parallel", maxParallel: 2 },
  { vramGb: 23, tier: "high", mode: "parallel", maxParallel: 2 },
  { vramGb: 24, tier: "ultra", mode: "parallel", maxParallel: 4 },
  { vramGb: 32, tier: "ultra", mode: "parallel", maxParallel: 4 },
];

describe("adviseGuardrails — tier boundaries", () => {
  for (const c of CASES) {
    it(`assigns vram_gb=${c.vramGb} to tier '${c.tier}' (${c.mode}, max_parallel=${c.maxParallel})`, () => {
      const advice = adviseGuardrails({ vram_gb: c.vramGb });
      expect(advice.tier).toBe(c.tier);
      expect(advice.mode).toBe(c.mode);
      expect(advice.max_parallel_models).toBe(c.maxParallel);
    });
  }

  it("always returns a non-empty, explainable reason string", () => {
    for (const c of CASES) {
      const advice = adviseGuardrails({ vram_gb: c.vramGb });
      expect(advice.reason.length).toBeGreaterThan(0);
      expect(advice.reason).toContain("vram_gb");
    }
  });

  it("always returns a non-empty recommendation", () => {
    for (const c of CASES) {
      expect(adviseGuardrails({ vram_gb: c.vramGb }).recommendation.length).toBeGreaterThan(0);
    }
  });

  it("rounds sub-tier values into the correct tier (e.g. 0 and 5.9)", () => {
    expect(adviseGuardrails({ vram_gb: 0 }).tier).toBe("baseline");
    expect(adviseGuardrails({ vram_gb: 5.9 }).tier).toBe("baseline");
    expect(adviseGuardrails({ vram_gb: 11.9 }).tier).toBe("mid");
    expect(adviseGuardrails({ vram_gb: 23.9 }).tier).toBe("high");
  });
});
