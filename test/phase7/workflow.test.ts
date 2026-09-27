/**
 * Phase 7 gate — Workflow #1 full pipeline (test suite items 2-6).
 *
 * The default regimen is 29 units: 8 deterministic (task2/7/10) and 21
 * orchestrator_judged. Every pipeline test uses a fresh harness so a second
 * run of the same model never contaminates counts/results.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRegimenHarness, passAllReplies, type RegimenHarness } from "./helpers.js";
import { getPendingJudgments } from "../../src/workflows/getPendingJudgments.js";
import { submitTestJudgment } from "../../src/workflows/submitTestJudgment.js";

const MODEL = "openai/gpt-oss-20b";
const DETERMINISTIC_UNITS = 8;
const JUDGED_UNITS = 21;
const PARAM_ATTEMPTS = DETERMINISTIC_UNITS * 2; // baseline + variant per unit

describe("Phase 7 gate — test regimen pipeline", () => {
  let h: RegimenHarness;

  beforeEach(async () => {
    h = await createRegimenHarness({ replies: passAllReplies });
  });
  afterEach(async () => {
    await h.close();
  });

  it("deterministic units auto-score with zero orchestrator involvement", async () => {
    const summary = await h.runRegimen(MODEL);
    expect(summary.deterministic_scored).toBe(DETERMINISTIC_UNITS);
    const detResults = h.deps.testResults.list("t", MODEL).filter((r) => r.status === "approved");
    expect(detResults).toHaveLength(DETERMINISTIC_UNITS);
    expect(detResults.every((r) => r.score === 100)).toBe(true);
    expect(detResults.every((r) => r.raw_output === null)).toBe(true);
  });

  it("orchestrator_judged units land pending and only pending ids are returned", async () => {
    const summary = await h.runRegimen(MODEL);
    expect(summary.pending_unit_ids).toHaveLength(JUDGED_UNITS);
    expect(summary.registered_entry).toBeNull(); // nothing final while pending
    const pending = h.deps.testResults.listPending("t", MODEL);
    expect(pending).toHaveLength(JUDGED_UNITS);
    expect(pending.every((r) => r.raw_output && r.raw_output.length > 0)).toBe(true); // cleaned raw logged
  });

  it("param search logs every attempted config, not just the winner", async () => {
    await h.runRegimen(MODEL);
    const attempts = h.deps.paramSearch.list("t", MODEL);
    expect(attempts).toHaveLength(PARAM_ATTEMPTS);
    // Sequential attempt numbering, every one with params + a score.
    attempts.forEach((a, i) => {
      expect(a.attempt).toBe(i + 1);
      expect(Object.keys(a.params).length).toBeGreaterThan(0);
      expect(typeof a.score).toBe("number");
    });
    // Both the baseline (temperature 0) and the variant were tried.
    const temps = attempts.map((a) => a.params.temperature);
    expect(temps).toContain(0);
    expect(temps.some((t) => (t ?? 0) > 0)).toBe(true);
  });

  it("no judged units + only deterministic units: registry entry written immediately", async () => {
    // Remove the default regimen, then register a single deterministic unit to
    // isolate immediate finalization (nothing pending -> entry written).
    for (const u of h.deps.testUnits.list("t")) h.deps.testUnits.remove("t", u.id);
    const mini = {
      id: "mini-det",
      name: "one deterministic unit",
      task_group: "t",
      difficulty: "easy",
      prompts: [{ id: "a", text: "Classify as exactly one of: BUG, FEATURE, QUESTION, OTHER. Respond with only the label.\n\n\"export my data\"" }],
      measures: ["format_compliance"],
      applicable_roles: ["classifier"],
      recommended_config: { context_length: 2000, kv_cache_quant: "Q4", temperature: 0, top_p: 1, top_k: 1, repeat_penalty: 1, max_output_tokens: 10 },
      scoring: { method: "deterministic_rule", rule: { type: "exact_match", params: { expected: "QUESTION" } } },
      source: "custom_authored",
      version: 1,
    } as const;
    h.deps.testUnits.register("t", mini);
    const summary = await h.runRegimen("mini-model");
    expect(summary.pending_unit_ids).toHaveLength(0);
    expect(summary.registered_entry).not.toBeNull();
    // E1: scores are role-keyed — the unit's classifier score lands on its role.
    expect(summary.registered_entry!.scores["classifier"]).toBe(100);
    expect(summary.registered_entry!.roles).toContain("classifier");
    expect(summary.registered_entry!.score_minima?.["classifier"]).toBe(100);
    expect(Object.keys(summary.registered_entry!.scores).some((k) => k === "mini-det")).toBe(false);
    expect(Object.keys(summary.registered_entry!.best_params).length).toBeGreaterThan(0);
    expect(summary.registered_entry!.last_tested).toBeTruthy();
  });

  it("unload is called exactly once on the success path", async () => {
    await h.runRegimen(MODEL);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
  });
});

describe("Phase 7 gate — judgment flow", () => {
  let h: RegimenHarness;

  beforeEach(async () => {
    h = await createRegimenHarness({ replies: passAllReplies });
    await h.runRegimen(MODEL);
  });
  afterEach(async () => {
    await h.close();
  });

  it("get_pending_judgments returns cleaned raw output + rubric for pending units only", () => {
    const { pending } = getPendingJudgments(h.deps, "t", MODEL);
    expect(pending).toHaveLength(JUDGED_UNITS);
    for (const p of pending) {
      expect(p.rubric && p.rubric.length > 10).toBe(true);
      expect(p.prompt_texts.length).toBeGreaterThan(0);
      expect(p.raw_output.length).toBeGreaterThan(0);
    }
  });

  it("get_pending_judgments honors a requested subset; a non-pending id is a caller error", () => {
    const ids = h.deps.testResults.listPending("t", MODEL).slice(0, 2).map((r) => r.unit_id);
    const { pending } = getPendingJudgments(h.deps, "t", MODEL, ids);
    expect(pending.map((p) => p.unit_id).sort()).toEqual([...ids].sort());
    expect(() => getPendingJudgments(h.deps, "t", MODEL, ["task2-extraction-easy"])).toThrow(/not pending/i);
  });

  it("registry stays absent until every pending candidate is approved (serial judging: two passes per unit)", () => {
    let submissions = 0;
    let sawEarlyEntry = false;
    for (;;) {
      const pending = h.deps.testResults.listPending("t", MODEL);
      if (pending.length === 0) break;
      for (const r of pending) {
        submissions++;
        const res = submitTestJudgment(h.deps, {
          profile: "t",
          model_id: MODEL,
          unit_id: r.unit_id,
          score: 90,
          orchestrator_notes: "looks good",
          user_approved: true,
        });
        expect(res.status).toBe("approved");
        // Approving the baseline promotes its variant to pending, so the entry
        // must not finalize until the last of the 2x judged passes drains.
        if (res.registered_entry !== null && submissions < JUDGED_UNITS * 2) sawEarlyEntry = true;
      }
    }
    expect(submissions).toBe(JUDGED_UNITS * 2); // baseline + variant per judged unit
    expect(sawEarlyEntry).toBe(false); // nothing final while any candidate pending

    const entry = h.deps.registry.get("t", MODEL);
    expect(entry).not.toBeNull();
    // E1 role-keyed entry: scores/minima keyed by the tested units' roles, not
    // by unit ids; every tested unit's role union is present.
    const roleUnion = [...new Set(h.deps.testUnits.list("t").flatMap((u) => u.applicable_roles))].sort();
    expect(Object.keys(entry!.scores).sort()).toEqual(roleUnion);
    expect(Object.keys(entry!.score_minima ?? {}).sort()).toEqual(roleUnion);
    expect(Object.keys(entry!.scores).every((k) => roleUnion.includes(k))).toBe(true);
    for (const s of Object.values(entry!.scores)) {
      expect(typeof s).toBe("number");
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
    // E6: best_params carries sampling params only.
    const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "repeat_penalty"];
    expect(Object.keys(entry!.best_params).every((k) => SAMPLING.includes(k))).toBe(true);
    expect(entry!.last_tested).toBeTruthy();
  });

  it("user_approved: false keeps that candidate out; serial judging promotes the sibling", () => {
    const first = h.deps.testResults.listPending("t", MODEL)[0]!.unit_id;
    submitTestJudgment(h.deps, {
      profile: "t",
      model_id: MODEL,
      unit_id: first,
      score: 40,
      orchestrator_notes: "no",
      user_approved: false,
    });
    const rows = h.deps.testResults.list("t", MODEL).filter((r) => r.unit_id === first);
    const baseline = rows.find((r) => r.candidate === "baseline")!;
    const variant = rows.find((r) => r.candidate === "variant")!;
    expect(baseline.status).toBe("judged"); // recorded, but kept out of the registry
    expect(baseline.score).toBe(40);
    expect(variant.status).toBe("pending"); // promoted for the second judgment pass
    expect(h.deps.registry.get("t", MODEL)).toBeNull(); // nothing approved yet
  });

  it("submitting an unknown unit or a unit with no live pending row is a structured error", () => {
    expect(() =>
      submitTestJudgment(h.deps, { profile: "t", model_id: MODEL, unit_id: "nope", score: 50, orchestrator_notes: "x", user_approved: true }),
    ).toThrow(/no test result/i);

    // Fully drain one unit (both candidates) so it has no live pending row.
    const first = h.deps.testResults.listPending("t", MODEL)[0]!.unit_id;
    submitTestJudgment(h.deps, { profile: "t", model_id: MODEL, unit_id: first, score: 50, orchestrator_notes: "x", user_approved: true });
    submitTestJudgment(h.deps, { profile: "t", model_id: MODEL, unit_id: first, score: 50, orchestrator_notes: "x", user_approved: true });
    expect(() =>
      submitTestJudgment(h.deps, { profile: "t", model_id: MODEL, unit_id: first, score: 50, orchestrator_notes: "x", user_approved: true }),
    ).toThrow(/not pending/i);
  });
});

describe("Phase 7 gate — unload exactly once on failure paths", () => {
  it("mid-test chat failure: pipeline aborts, unload fires exactly once", async () => {
    let calls = 0;
    const h = await createRegimenHarness({ replies: () => (calls++ === 0 ? undefined : "ok") });
    await expect(h.runRegimen(MODEL)).rejects.toThrow();
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });

  it("timeout: pipeline aborts, unload fires exactly once", async () => {
    const h = await createRegimenHarness({ replies: () => "ok", chatDelayMs: 300 });
    await expect(h.runRegimen(MODEL, { clientTimeoutMs: 100 })).rejects.toThrow(/timed out/i);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });

  it("load failure: no instance, no unload attempted", async () => {
    const h = await createRegimenHarness({ loadFailure: true });
    await expect(h.runRegimen(MODEL)).rejects.toThrow(/HTTP 500/i);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(0);
    await h.close();
  });
});
