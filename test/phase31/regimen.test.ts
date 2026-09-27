/**
 * Phase 31 (E gate) — items 4 + 5: idempotent pending and the serial judged
 * flow. A judged unit that already holds a live (pending|staged) row is skipped
 * by a regimen re-run — no stacked rows, no doubled chats. Under the serial
 * flow a single unit runs baseline->pending and variant->staged; approving the
 * baseline logs its attempt with the real score and promotes the staged variant
 * to pending; the second submission drains it and finalize aggregates the
 * winner. best_params then reflects the higher-scoring candidate and carries
 * sampling params only (E6).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRegimenHarness, type RegimenHarness } from "../phase7/helpers.js";
import { getPendingJudgments } from "../../src/workflows/getPendingJudgments.js";
import { submitTestJudgment } from "../../src/workflows/submitTestJudgment.js";
import { judgedUnit, SAMPLING } from "./helpers.js";

const MODEL = "openai/gpt-oss-20b";
const UNIT = "judged-u";

describe("Phase 31 — idempotent pending (E4)", () => {
  let h: RegimenHarness;

  beforeEach(async () => {
    h = await createRegimenHarness();
    h.deps.testUnits.register("t", judgedUnit());
  });
  afterEach(async () => {
    await h.close();
  });

  it("re-running the regimen on a still-pending judged unit neither stacks rows nor re-runs its chats", async () => {
    const first = await h.runRegimen(MODEL);
    expect(first.pending_unit_ids).toEqual([UNIT]);
    expect(h.counts.chats).toBe(2); // baseline + variant, one prompt each
    expect(h.deps.testResults.listPending("t", MODEL)).toHaveLength(1);
    expect(h.deps.testResults.listStaged("t", MODEL)).toHaveLength(1);

    // Second run on the same still-pending unit: skipped (stamped, not stacked).
    const second = await h.runRegimen(MODEL);
    expect(second.pending_unit_ids).toEqual([UNIT]);
    expect(second.registered_entry).toBeNull();
    expect(h.counts.chats).toBe(2); // no judged chats were re-run
    expect(h.deps.testResults.listPending("t", MODEL)).toHaveLength(1);
    expect(h.deps.testResults.listStaged("t", MODEL)).toHaveLength(1);

    // The surviving live rows were adopted into the newer test_run (2), so a
    // later judgment still reaches the latest-run aggregation.
    const rows = h.deps.testResults.list("t", MODEL);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.test_run === 2)).toBe(true);
  });
});

describe("Phase 31 — serial judged flow + winner-based best_params (E4/E6)", () => {
  let h: RegimenHarness;

  beforeEach(async () => {
    h = await createRegimenHarness();
    h.deps.testUnits.register("t", judgedUnit());
  });
  afterEach(async () => {
    await h.close();
  });

  it("baseline pends -> submit -> variant promoted -> submit -> winner aggregated, sampling-only best_params", async () => {
    await h.runRegimen(MODEL);

    // Pass 1: the pending row is the baseline candidate.
    const firstPass = getPendingJudgments(h.deps, "t", MODEL);
    expect(firstPass.pending).toHaveLength(1);
    expect(firstPass.pending[0]!.unit_id).toBe(UNIT);

    const baselineRes = submitTestJudgment(h.deps, {
      profile: "t", model_id: MODEL, unit_id: UNIT, score: 90,
      orchestrator_notes: "baseline approved", user_approved: true,
    });
    expect(baselineRes.status).toBe("approved");
    expect(baselineRes.registered_entry).toBeNull(); // variant now pending

    // The staged variant was promoted to pending for the second judgment pass.
    const promoted = h.deps.testResults.list("t", MODEL).find((r) => r.candidate === "variant")!;
    expect(promoted.status).toBe("pending");
    const secondPass = getPendingJudgments(h.deps, "t", MODEL);
    expect(secondPass.pending).toHaveLength(1);
    expect(secondPass.pending[0]!.unit_id).toBe(UNIT);

    // Pass 2: the variant scores lower; approving it still drains the unit.
    const variantRes = submitTestJudgment(h.deps, {
      profile: "t", model_id: MODEL, unit_id: UNIT, score: 40,
      orchestrator_notes: "variant weaker", user_approved: true,
    });
    expect(variantRes.status).toBe("approved");
    expect(variantRes.registered_entry).not.toBeNull();

    // Both candidates judged; both attempts logged with the real score at
    // submit time (D10), attributed to their candidate.
    const attempts = h.deps.paramSearch.list("t", MODEL);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attempt: 1, candidate: "baseline", unit_id: UNIT, detail: "orchestrator_judged:baseline", score: 90 });
    expect(attempts[1]).toMatchObject({ attempt: 2, candidate: "variant", unit_id: UNIT, detail: "orchestrator_judged:variant", score: 40 });

    // Aggregation collapses the unit to its winner (baseline 90 > variant 40).
    const entry = h.deps.registry.get("t", MODEL)!;
    expect(entry.scores.reviewer).toBe(90);
    expect(entry.score_minima?.reviewer).toBe(90);

    // best_params reflects the higher-scoring (baseline, temp 0.2) candidate and
    // carries sampling params only — no output/context/reasoning sizing (E6).
    expect(Object.keys(entry.best_params).every((k) => SAMPLING.includes(k))).toBe(true);
    expect(entry.best_params.temperature).toBe(0.2);
    expect("max_output_tokens" in entry.best_params).toBe(false);
    expect("context_length" in entry.best_params).toBe(false);

    // Nothing left pending after the drain.
    expect(h.deps.testResults.listPending("t", MODEL)).toHaveLength(0);
  });
});
