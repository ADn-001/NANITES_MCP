/**
 * Phase CP-2 gate — guardrail advisor now models concurrency as a pair
 * (process capacity × num_parallel slots) per the locked 2026-09-05 mapping:
 *   <6 / 6-12GB  -> forced (1,1) sequential, no override
 *   12-24 (high) -> (2,2) only
 *   24+ (ultra)  -> allowed (2,2),(4,2),(2,4),(4,4), default (4,2)
 * Every tier returns additive num_parallel / allowed_pairs, and the reason
 * string names the pair (plus a KV-cache warning wherever 4-slot combos appear).
 */
import { describe, expect, it } from "vitest";
import { adviseGuardrails, effectiveGuardrailAdvice } from "../../src/guardrails/advisor.js";
import { defaultPairForVram, pairKey } from "../../src/guardrails/tiers.js";

describe("adviseGuardrails — forced sequential tiers (<6 / 6-12GB)", () => {
  const forced = [0, 4, 5.9, 6, 11.9];

  it("forces pair (1,1), sequential, and exposes an empty allowed set", () => {
    for (const vram of forced) {
      const a = adviseGuardrails({ vram_gb: vram });
      expect(a.mode).toBe("sequential");
      expect(a.max_parallel_models).toBe(1);
      expect(a.num_parallel).toBe(1);
      expect(a.allowed_pairs).toEqual([]);
    }
  });

  it("reason names the pair and states it is not user-overridable", () => {
    const a = adviseGuardrails({ vram_gb: 4 });
    expect(a.reason).toContain("1x1");
    expect(a.reason.toLowerCase()).toContain("not user-overridable");
  });
});

describe("adviseGuardrails — high tier (12-24GB)", () => {
  it("defaults to (2,2) and allows only (2,2)", () => {
    const a = adviseGuardrails({ vram_gb: 16 });
    expect(a.mode).toBe("parallel");
    expect(a.max_parallel_models).toBe(2);
    expect(a.num_parallel).toBe(2);
    expect(a.allowed_pairs).toEqual([{ max_parallel_models: 2, num_parallel: 2 }]);
  });

  it("reason names the pair and does not warn about KV (no 4-slot allowed)", () => {
    const a = adviseGuardrails({ vram_gb: 16 });
    expect(a.reason).toContain("2x2");
    expect(a.reason).not.toContain("KV-cache");
  });
});

describe("adviseGuardrails — ultra tier (24+GB)", () => {
  it("defaults to (4,2) and allows all four pairs", () => {
    const a = adviseGuardrails({ vram_gb: 40 });
    expect(a.mode).toBe("parallel");
    expect(a.max_parallel_models).toBe(4);
    expect(a.num_parallel).toBe(2);
    expect(a.allowed_pairs.map(pairKey)).toEqual(["2x2", "4x2", "2x4", "4x4"]);
  });

  it("reason lists the override options and warns 4-slot combos multiply KV-cache", () => {
    const a = adviseGuardrails({ vram_gb: 40 });
    expect(a.reason).toContain("4x2");
    expect(a.reason).toContain("2x4, 4x4");
    expect(a.reason).toContain("KV-cache");
  });
});

describe("defaultPairForVram", () => {
  it("returns the tier default pair keyed off VRAM", () => {
    expect(defaultPairForVram(4)).toEqual({ max_parallel_models: 1, num_parallel: 1 });
    expect(defaultPairForVram(16)).toEqual({ max_parallel_models: 2, num_parallel: 2 });
    expect(defaultPairForVram(40)).toEqual({ max_parallel_models: 4, num_parallel: 2 });
  });
});

describe("effectiveGuardrailAdvice — additive pair fields mirror the live tier", () => {
  it("carries num_parallel + allowed_pairs for the effective tier", () => {
    // 4GB spec, no live VRAM surface -> static baseline tier, forced (1,1).
    const nullVram = effectiveGuardrailAdvice({ vram_gb: 4 }, null);
    expect(nullVram.effective_tier).toBe("baseline");
    expect(nullVram.max_parallel_models).toBe(1);
    expect(nullVram.num_parallel).toBe(1);
    expect(nullVram.allowed_pairs).toEqual([]);

    // 40GB spec, live free VRAM drops to 16GB -> effective high tier (2x2).
    const downgraded = effectiveGuardrailAdvice({ vram_gb: 40 }, 16);
    expect(downgraded.effective_tier).toBe("high");
    expect(downgraded.downgraded).toBe(true);
    expect(downgraded.num_parallel).toBe(2);
    expect(downgraded.allowed_pairs).toEqual([{ max_parallel_models: 2, num_parallel: 2 }]);

    // No downgrade: 40GB spec, 64GB free -> ultra default (4x2), four allowed.
    const steady = effectiveGuardrailAdvice({ vram_gb: 40 }, 64);
    expect(steady.downgraded).toBe(false);
    expect(steady.num_parallel).toBe(2);
    expect(steady.allowed_pairs).toHaveLength(4);
  });
});
