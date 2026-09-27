/**
 * Phase 9 gate — guardrail-tier filtering of candidate models (test suite item
 * 2). Pure function: params label in, fit verdict + reason out. A model far
 * outside the tier's recommended range is excluded with an explicit reason,
 * never silently suggested.
 */
import { describe, expect, it } from "vitest";
import { filterByGuardrail, paramsToBillions } from "../../src/workflows/guardrailFilter.js";

describe("paramsToBillions", () => {
  it("parses B and M labels into billions", () => {
    expect(paramsToBillions("20B")).toBe(20);
    expect(paramsToBillions("270M")).toBeCloseTo(0.27);
    expect(paramsToBillions("7B v3")).toBe(7);
    expect(paramsToBillions("1.5B")).toBe(1.5);
    expect(paramsToBillions("34b")).toBe(34);
  });

  it("returns null for unknown/garbage", () => {
    expect(paramsToBillions(null)).toBeNull();
    expect(paramsToBillions(undefined)).toBeNull();
    expect(paramsToBillions("")).toBeNull();
    expect(paramsToBillions("gguf")).toBeNull();
    expect(paramsToBillions("no numbers here")).toBeNull();
  });
});

describe("filterByGuardrail", () => {
  const cands = [
    { model: "a/270m", params: "270M" },
    { model: "b/7b", params: "7B" },
    { model: "c/14b", params: "14B" },
    { model: "d/20b", params: "20B" },
    { model: "e/70b", params: "70B" },
    { model: "f/unknown" },
  ];

  it("baseline tier (4GB) keeps <=8B, excludes far-larger, flags unknown for review", () => {
    const { kept, excluded } = filterByGuardrail(cands, 4);
    expect(kept.map((c) => c.model).sort()).toEqual(["a/270m", "b/7b", "f/unknown"]);
    expect(excluded.map((c) => c.model).sort()).toEqual(["c/14b", "d/20b", "e/70b"]);
    const f = kept.find((c) => c.model === "f/unknown")!;
    expect(f.fits).toBe(true);
    expect(f.reason).toMatch(/unknown/);
  });

  it("mid tier (6GB) keeps up to 14B", () => {
    const { kept, excluded } = filterByGuardrail(cands, 6);
    expect(kept.some((c) => c.model === "c/14b")).toBe(true);
    expect(excluded.some((c) => c.model === "d/20b")).toBe(true);
  });

  it("high tier (16GB) keeps up to 34B, excludes 70B", () => {
    const { kept, excluded } = filterByGuardrail(cands, 16);
    expect(kept.some((c) => c.model === "d/20b")).toBe(true);
    expect(excluded.map((c) => c.model)).toEqual(["e/70b"]);
  });

  it("exclusion reasons name the tier and the ceiling", () => {
    const { excluded } = filterByGuardrail(cands, 4);
    const e = excluded.find((c) => c.model === "e/70b")!;
    expect(e.reason).toMatch(/baseline tier/i);
    expect(e.reason).toMatch(/8B/);
    expect(e.fits).toBe(false);
  });

  it("empty candidate list -> empty shortlist", () => {
    const { kept, excluded } = filterByGuardrail([], 4);
    expect(kept).toHaveLength(0);
    expect(excluded).toHaveLength(0);
  });
});
