/**
 * Phase CP-2 gate — pure concurrency-override validation + effective-config
 * derivation. An override is accepted iff a member of the effective tier's
 * allowed set; forced sequential tiers allow no override at all.
 */
import { describe, expect, it } from "vitest";
import {
  validateConcurrencyOverride,
  concurrencyFromSpec,
  concurrencyWithOverride,
  concurrencyConfigFromPair,
} from "../../src/storage/profileDefaults.js";
import { pairKey, pairAllowedOnTier, pairIsSequential, allowedPairsForVram } from "../../src/guardrails/tiers.js";

describe("validateConcurrencyOverride", () => {
  it("accepts (2,2) on the high tier (12-24GB)", () => {
    const v = validateConcurrencyOverride(16, { max_parallel_models: 2, num_parallel: 2 });
    expect(v.ok).toBe(true);
  });

  it("rejects (4,4) on the high tier — outside its single allowed pair", () => {
    const v = validateConcurrencyOverride(16, { max_parallel_models: 4, num_parallel: 4 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("concurrency_override_invalid");
      expect(v.message).toContain("4x4");
      expect(v.message).toContain("2x2");
    }
  });

  it("accepts all four pairs on the ultra tier (24+GB)", () => {
    for (const p of [
      { max_parallel_models: 2, num_parallel: 2 },
      { max_parallel_models: 4, num_parallel: 2 },
      { max_parallel_models: 2, num_parallel: 4 },
      { max_parallel_models: 4, num_parallel: 4 },
    ]) {
      expect(validateConcurrencyOverride(40, p).ok).toBe(true);
    }
  });

  it("rejects every override on forced sequential tiers (even the tier default)", () => {
    // (1,1) mirrors the derived pair but is still not in the (empty) allowed set.
    for (const vram of [4, 11]) {
      const v = validateConcurrencyOverride(vram, { max_parallel_models: 1, num_parallel: 1 });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toContain("forced sequential");
    }
  });

  it("rejects an exotic pair like (2,1) on the ultra tier", () => {
    const v = validateConcurrencyOverride(40, { max_parallel_models: 2, num_parallel: 1 });
    expect(v.ok).toBe(false);
  });
});

describe("pair helpers", () => {
  it("pairIsSequential only for (1,1)", () => {
    expect(pairIsSequential({ max_parallel_models: 1, num_parallel: 1 })).toBe(true);
    expect(pairIsSequential({ max_parallel_models: 2, num_parallel: 2 })).toBe(false);
    expect(pairIsSequential({ max_parallel_models: 1, num_parallel: 4 })).toBe(false);
  });

  it("pairAllowedOnTier agrees with validateConcurrencyOverride", () => {
    expect(pairAllowedOnTier(16, { max_parallel_models: 2, num_parallel: 2 })).toBe(true);
    expect(pairAllowedOnTier(16, { max_parallel_models: 4, num_parallel: 4 })).toBe(false);
    expect(pairAllowedOnTier(40, { max_parallel_models: 4, num_parallel: 4 })).toBe(true);
    expect(pairAllowedOnTier(4, { max_parallel_models: 1, num_parallel: 1 })).toBe(false);
  });

  it("allowedPairsForVram returns the tier's allowed set (copy)", () => {
    expect(allowedPairsForVram(16).map(pairKey)).toEqual(["2x2"]);
    expect(allowedPairsForVram(40).map(pairKey)).toEqual(["2x2", "4x2", "2x4", "4x4"]);
    expect(allowedPairsForVram(4)).toEqual([]);
  });
});

describe("derived vs overridden effective config", () => {
  const spec4 = { cpu: "c", gpu: "g", vram_gb: 4, ram_gb: 16, storage: "ssd" };
  const spec32 = { ...spec4, vram_gb: 32 };

  it("concurrencyFromSpec derives the tier default pair + mode", () => {
    expect(concurrencyFromSpec(spec4)).toEqual({ mode: "sequential", max_parallel_models: 1, num_parallel: 1 });
    expect(concurrencyFromSpec(spec32)).toEqual({ mode: "parallel", max_parallel_models: 4, num_parallel: 2 });
  });

  it("no override -> derived default wins", () => {
    expect(concurrencyWithOverride(spec4, null)).toEqual({ mode: "sequential", max_parallel_models: 1, num_parallel: 1 });
    expect(concurrencyWithOverride(spec32, undefined)).toEqual({ mode: "parallel", max_parallel_models: 4, num_parallel: 2 });
  });

  it("a valid override wins over the derived default", () => {
    const cfg = concurrencyWithOverride(spec32, { max_parallel_models: 4, num_parallel: 4 });
    expect(cfg).toEqual({ mode: "parallel", max_parallel_models: 4, num_parallel: 4 });
  });

  it("concurrencyConfigFromPair derives mode from the pair", () => {
    expect(concurrencyConfigFromPair({ max_parallel_models: 1, num_parallel: 1 }).mode).toBe("sequential");
    expect(concurrencyConfigFromPair({ max_parallel_models: 2, num_parallel: 4 }).mode).toBe("parallel");
  });
});
