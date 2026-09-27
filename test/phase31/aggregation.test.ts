/**
 * Phase 31 (E gate) — items 1 + 3: the E1 role-keyed aggregation and the
 * re-finalize regression. finalizeIfComplete must emit `scores` as role->mean
 * and `score_minima` as role->min from the *approved winner rows of the latest
 * test_run only*; older-run approved rows are excluded; a unit that approved
 * both candidates collapses to its higher-scoring one. No unit-id keys ever
 * leak into `scores`, and re-running finalize is idempotent.
 */
import { describe, expect, it } from "vitest";
import { finalizeIfComplete } from "../../src/workflows/finalize.js";
import { detUnit, judgedUnit, makeStoreDeps, type StoreDeps } from "./helpers.js";

const MODEL = "openai/gpt-oss-20b";

describe("Phase 31 — E1 aggregation: role-keyed means/minima over the latest run", () => {
  it("finalize emits role means/minima from approved winner rows of the latest test_run only", () => {
    const s = makeStoreDeps();
    try {
      // Two units share `reviewer`; u2 also maps `summarizer`.
      const u1 = judgedUnit({ id: "u1", applicable_roles: ["reviewer"] });
      const u2 = judgedUnit({ id: "u2", applicable_roles: ["summarizer", "reviewer"] });
      s.deps.testUnits.register("t", u1);
      s.deps.testUnits.register("t", u2);

      // Run 1 (old): u1 approved at 100 (would push the min to 60 if included),
      // u2 approved at 60 (would drag summarizer's mean to 65 if included).
      s.deps.testResults.insert({ profile_name: "t", model_id: MODEL, unit_id: "u1", status: "approved", candidate: "baseline", test_run: 1, score: 100, raw_output: null });
      s.deps.testResults.insert({ profile_name: "t", model_id: MODEL, unit_id: "u2", status: "approved", candidate: "baseline", test_run: 1, score: 60, raw_output: null });

      // Run 2 (latest): u1 approves BOTH candidates (collapse -> winner 90);
      // u2 approves its baseline at 70.
      s.deps.testResults.insert({ profile_name: "t", model_id: MODEL, unit_id: "u1", status: "approved", candidate: "baseline", test_run: 2, score: 70, raw_output: null });
      s.deps.testResults.insert({ profile_name: "t", model_id: MODEL, unit_id: "u1", status: "approved", candidate: "variant", test_run: 2, score: 90, raw_output: null });
      s.deps.testResults.insert({ profile_name: "t", model_id: MODEL, unit_id: "u2", status: "approved", candidate: "baseline", test_run: 2, score: 70, raw_output: null });

      const entry = finalizeIfComplete(s.deps, "t", MODEL);
      expect(entry).not.toBeNull();
      expect(entry!.roles).toEqual(["reviewer", "summarizer"]);
      // reviewer <- [90 (u1 winner), 70 (u2)] -> mean 80, min 70. If run 1 were
      // counted or both candidates summed, the mean/min would differ.
      expect(entry!.scores.reviewer).toBe(80);
      expect(entry!.score_minima!.reviewer).toBe(70);
      // summarizer <- [70 (u2)] -> mean 70, min 70. Run 1's 60 must be excluded.
      expect(entry!.scores.summarizer).toBe(70);
      expect(entry!.score_minima!.summarizer).toBe(70);
      // No unit-id keys leak into scores/minima; best_params + stamp present.
      expect(Object.keys(entry!.scores).every((k) => ["reviewer", "summarizer"].includes(k))).toBe(true);
      expect(Object.keys(entry!.score_minima ?? {}).every((k) => ["reviewer", "summarizer"].includes(k))).toBe(true);
      expect(entry!.last_tested).toBeTruthy();
    } finally {
      s.close();
    }
  });

  it("running finalize twice is idempotent and leaves no unit-key residue", () => {
    const s = makeStoreDeps();
    try {
      const u1 = judgedUnit({ id: "r1", applicable_roles: ["reviewer", "summarizer"] });
      s.deps.testUnits.register("t", u1);
      s.deps.testResults.insert({ profile_name: "t", model_id: MODEL, unit_id: "r1", status: "approved", candidate: "baseline", test_run: 1, score: 88, raw_output: null });

      const first = finalizeIfComplete(s.deps, "t", MODEL);
      const second = finalizeIfComplete(s.deps, "t", MODEL);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.roles).toEqual(first!.roles);
      expect(second!.scores).toEqual(first!.scores);
      expect(second!.score_minima).toEqual(first!.score_minima);
      // score_minima is always present after finalize.
      expect(second!.score_minima?.reviewer).toBe(88);
      expect(second!.score_minima?.summarizer).toBe(88);
      // Every score key is a role key; no unit-id (e.g. "r1") residue.
      for (const k of Object.keys(second!.scores)) expect(second!.roles).toContain(k);
      expect(Object.keys(second!.scores).some((k) => k === "r1")).toBe(false);
    } finally {
      s.close();
    }
  });
});
