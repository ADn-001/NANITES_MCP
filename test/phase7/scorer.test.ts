import { describe, expect, it } from "vitest";
import { scoreDeterministicRule } from "../../src/testunits/scorer.js";

describe("Phase 7 gate — deterministic rule scorer", () => {
  it("json_valid: parseable passes, prose fails", () => {
    expect(scoreDeterministicRule('{"a":1}', { type: "json_valid", params: {} }).score).toBe(100);
    expect(scoreDeterministicRule("Here is my answer", { type: "json_valid", params: {} }).score).toBe(0);
  });

  it("exact_match: trims and compares exactly", () => {
    const rule = { type: "exact_match", params: { expected: "7" } } as const;
    expect(scoreDeterministicRule("  7\n", rule).score).toBe(100);
    expect(scoreDeterministicRule("7 bytes", rule).score).toBe(0);
  });

  it("label_in_set: a committed single label passes, hedging fails", () => {
    const rule = { type: "label_in_set", params: { set: ["BUG", "FEATURE", "QUESTION", "OTHER"] } } as const;
    expect(scoreDeterministicRule("QUESTION", rule).score).toBe(100);
    expect(scoreDeterministicRule("FEATURE", rule).score).toBe(100);
    expect(scoreDeterministicRule("Hmm, probably a BUG I guess", rule).score).toBe(0);
  });

  it("regex_match: pattern applied to the trimmed output", () => {
    const rule = { type: "regex_match", params: { pattern: "\\d{2,}" } } as const;
    expect(scoreDeterministicRule("found 42 rows", rule).score).toBe(100);
    expect(scoreDeterministicRule("none", rule).score).toBe(0);
  });

  it("regex_match: an invalid pattern scores 0, does not throw", () => {
    const rule = { type: "regex_match", params: { pattern: "(" } } as const;
    const result = scoreDeterministicRule("x", rule);
    expect(result.score).toBe(0);
  });

  it("every result carries a human detail string", () => {
    for (const rule of [
      { type: "json_valid", params: {} },
      { type: "exact_match", params: { expected: "7" } },
      { type: "label_in_set", params: { set: ["BUG"] } },
      { type: "regex_match", params: { pattern: "x" } },
    ] as const) {
      const r = scoreDeterministicRule("anything", rule);
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});
