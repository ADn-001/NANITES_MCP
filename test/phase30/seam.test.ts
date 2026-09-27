/**
 * Phase 30 gate (Phase D) — the tokenize seam. The chars/4 fallback keeps its
 * pre-seam numeric contract (empty -> 0, non-empty -> max(1, round(len/4)))
 * and never throws; the accurate path defers to a provider and falls back
 * deterministically; and the old estimator module converges on the seam
 * (single implementation, no `/4` duplicates left in src).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countTokens, countTokensAccurate, type TokenizerProvider } from "../../src/helpers/tokenize.js";
import { countTokens as tokenCounterCount } from "../../src/helpers/tokenCounter.js";

// 27 chars -> chars/4 rounds to 7. The fixture tokenizer yields a different
// number, so provider vs fallback is distinguishable in the provider test.
const SAMPLE = "hello world tokenizer probe";
const FALLBACK = 7;

describe("Phase 30 gate — tokenize seam fallback", () => {
  it("keeps the pinned chars/4 numeric contract and never throws", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("abcd")).toBe(1);
    expect(countTokens("a")).toBe(1);
    expect(countTokens("x".repeat(100))).toBe(25);
    expect(countTokens("    ")).toBe(1); // 4 chars -> 1
    expect(countTokens("\x00\x01\x02")).toBe(1); // control-heavy, non-empty
    expect(countTokens("😀".repeat(10))).toBeGreaterThanOrEqual(1);
  });

  it("falls back to chars/4 when no provider is set", async () => {
    expect(await countTokensAccurate(SAMPLE)).toBe(FALLBACK);
  });

  it("falls back to chars/4 when the provider returns null", async () => {
    const nullish: TokenizerProvider = { id: "stub-null", count: async () => null };
    expect(await countTokensAccurate(SAMPLE, { provider: nullish })).toBe(FALLBACK);
    expect(await countTokensAccurate(SAMPLE, { provider: null })).toBe(FALLBACK);
  });

  it("falls back to chars/4 when the provider throws or returns garbage", async () => {
    const throwing: TokenizerProvider = { id: "stub-throw", count: async () => { throw new Error("boom"); } };
    const garbage: TokenizerProvider = { id: "stub-garbage", count: async () => -5 as unknown as number };
    expect(await countTokensAccurate(SAMPLE, { provider: throwing })).toBe(FALLBACK);
    expect(await countTokensAccurate(SAMPLE, { provider: garbage })).toBe(FALLBACK);
  });

  it("returns the provider's count when it resolves one", async () => {
    const counting: TokenizerProvider = { id: "stub-count", count: async () => 123 };
    expect(await countTokensAccurate(SAMPLE, { provider: counting })).toBe(123);
  });
});

describe("Phase 30 gate — call sites converge on the seam", () => {
  it("tokenCounter re-exports the seam implementation (single estimator)", () => {
    expect(tokenCounterCount).toBe(countTokens);
  });

  it("leaves no chars/4 heuristic outside helpers/tokenize.ts", () => {
    const srcRoot = join(import.meta.dirname, "..", "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir)) {
        const p = join(dir, ent);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const text = readFileSync(p, "utf8");
          if (text.includes(".length / 4")) offenders.push(p);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([join(srcRoot, "helpers", "tokenize.ts")]);
  });

  it("runSubAgent imports the estimator from the seam module", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "workflows", "runSubAgent.ts"), "utf8");
    expect(src).toContain('import { countTokens } from "../helpers/tokenize.js";');
  });
});
