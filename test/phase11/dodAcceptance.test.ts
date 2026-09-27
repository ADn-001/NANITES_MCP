/**
 * Phase 11 gate — final acceptance: the full §7 Definition of Done checklist
 * walked end-to-end. Each `describe` block maps to one DoD bullet and must be
 * demonstrably true against the mocks, not "should work."
 *
 * Bullets:
 * 1. Profiles: create/switch/list + first-run init; guardrail visibly
 *    influences suggestions and is explainable.
 * 2. Modular test units: default regimen judge-then-approve; custom use case
 *    triggers adaptation, authors, validates, runs.
 * 3. Registry populated via the regimen, incl. orchestrator-approved scores.
 * 4. Sub-agent spawn/teardown with registry-recommended params, respecting
 *    the active profile's concurrency tier.
 * 5. /nanites-cost-saved reports accurately from real logged usage.
 * 6. ntfy fires when configured, silently skips when not.
 * 7. system_health_check catches a dead endpoint (autostart attempted) before
 *    a workflow wastes time discovering it mid-run.
 * 8. Companion skill drives delegation from registry + active profile; slash
 *    commands cover every deterministic script-chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPhase11Harness, type Phase11Harness } from "./helpers.js";
import { createRegimenHarness, passAllReplies, type RegimenHarness } from "../phase7/helpers.js";
import { createSubAgentHarness, type SubAgentHarness } from "../phase8/helpers.js";
import { getPendingJudgments } from "../../src/workflows/getPendingJudgments.js";
import { submitTestJudgment } from "../../src/workflows/submitTestJudgment.js";
import { DEFAULT_REGIMEN } from "../../src/testunits/defaultRegimen.js";

const MODEL = "openai/gpt-oss-20b";
const JUDGED_UNITS = 21;

describe("DoD 1 — profiles: CRUD + first-run + explainable guardrail", () => {
  let h: Phase11Harness;

  beforeEach(async () => {
    h = await createPhase11Harness({ createProfile: false });
  });
  afterEach(async () => {
    await h.close();
  });

  it("first-run status is true with zero profiles; create+switch leaves one active", async () => {
    const before = await h.callTool("get_first_run_status", {});
    expect((before.data as { needs_first_run: boolean }).needs_first_run).toBe(true);

    expect(await h.callTool("create_profile", { name: "work", machine_specs: { vram_gb: 4 } })).toMatchObject({ ok: true });
    expect(await h.callTool("switch_profile", { name: "work" })).toMatchObject({ ok: true });
    const active = await h.callTool("get_active_profile", {});
    expect((active.data as { profile: { name: string } }).profile.name).toBe("work");
    const listed = await h.callTool("list_profiles", {});
    expect((listed.data as { profiles: string[] }).profiles).toEqual(["work"]);

    const after = await h.callTool("get_first_run_status", {});
    expect((after.data as { needs_first_run: boolean }).needs_first_run).toBe(false);
  });

  it("guardrail visibly excludes an over-size candidate with an explainable reason", async () => {
    h.deps.profiles.createProfile({ name: "low", machine_specs: { vram_gb: 4 } });
    const res = await h.callTool("filter_by_guardrail", {
      profile: "low",
      candidates: [
        { model: "lmstudio-community/gemma-3-270m-it-qat", params: "270M" },
        { model: "tiiuae/falcon-40b", params: "40B" },
      ],
    });
    expect(res.ok).toBe(true);
    const data = res.data as { kept: Array<{ model: string; fits: boolean; reason: string }>; excluded: Array<{ model: string; reason: string }> };
    expect(data.kept.map((k) => k.model)).toContain("lmstudio-community/gemma-3-270m-it-qat");
    expect(data.kept[0]!.reason).toMatch(/fits the .*tier/);
    expect(data.excluded.map((x) => x.model)).toContain("tiiuae/falcon-40b");
    expect(data.excluded[0]!.reason).toMatch(/exceeds the .*tier recommended max/);
  });
});

describe("DoD 2+3 — regimen judge-then-approve populates the registry", () => {
  let h: RegimenHarness;

  beforeEach(async () => {
    h = await createRegimenHarness({ replies: passAllReplies });
  });
  afterEach(async () => {
    await h.close();
  });

  it("default regimen runs, deterministic auto-score, judged pending, then approved into the registry", async () => {
    const summary = await h.runRegimen(MODEL);
    expect(summary.deterministic_scored).toBeGreaterThan(0);
    expect(summary.pending_unit_ids).toHaveLength(JUDGED_UNITS);
    expect(summary.registered_entry).toBeNull();

    const { pending } = getPendingJudgments(h.deps, "t", MODEL);
    expect(pending).toHaveLength(JUDGED_UNITS);

    // Serial judging: two passes per judged unit (baseline, then its promoted
    // variant). Drain until no pending rows remain; the registry finalizes on
    // the last submission.
    let submissions = 0;
    let finalRegistered = false;
    let earlyEntry = false;
    for (;;) {
      const { pending: toJudge } = getPendingJudgments(h.deps, "t", MODEL);
      if (toJudge.length === 0) break;
      for (const p of toJudge) {
        submissions++;
        const res = submitTestJudgment(h.deps, {
          profile: "t",
          model_id: MODEL,
          unit_id: p.unit_id,
          score: 80,
          orchestrator_notes: "reviewed against rubric",
          user_approved: true,
        });
        if (res.registered_entry) {
          finalRegistered = true;
          if (submissions < JUDGED_UNITS * 2) earlyEntry = true;
        }
      }
    }
    expect(submissions).toBe(JUDGED_UNITS * 2);
    expect(earlyEntry).toBe(false);
    expect(finalRegistered).toBe(true);

    // E1: the registry score map is role-keyed (means per role from the tested
    // units' applicable_roles), never unit-keyed. Every regimen unit that was
    // scored (deterministic winners at 100, judged winners at the approved 80)
    // contributes to its roles.
    const entry = h.deps.registry.get("t", MODEL);
    expect(entry).not.toBeNull();
    const roleUnion = [...new Set(DEFAULT_REGIMEN.flatMap((u) => u.applicable_roles))].sort();
    expect(Object.keys(entry!.scores).sort()).toEqual(roleUnion);
    expect(Object.keys(entry!.score_minima ?? {}).sort()).toEqual(roleUnion);
    // No unit-id keys leak in; all score values stay in 0-100.
    expect(Object.keys(entry!.scores).every((k) => roleUnion.includes(k))).toBe(true);
    for (const s of Object.values(entry!.scores)) {
      expect(typeof s).toBe("number");
      expect(s).toBeGreaterThanOrEqual(80); // deterministic 100s and judged 80s floor at 80
      expect(s).toBeLessThanOrEqual(100);
    }
    const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "repeat_penalty"];
    expect(Object.keys(entry!.best_params).every((k) => SAMPLING.includes(k))).toBe(true);
    expect(entry!.last_tested).toBeTruthy();
  });

  it("user_approved false records the judgment but never finalizes that candidate", async () => {
    const summary = await h.runRegimen(MODEL);
    const first = summary.pending_unit_ids[0]!;
    submitTestJudgment(h.deps, {
      profile: "t", model_id: MODEL, unit_id: first, score: 10,
      orchestrator_notes: "suspicious", user_approved: false,
    });
    // Nothing approved yet -> registry still absent (variants remain pending).
    expect(h.deps.registry.get("t", MODEL)).toBeNull();
    const rows = h.deps.testResults.list("t", MODEL).filter((r) => r.unit_id === first);
    const baseline = rows.find((r) => r.candidate === "baseline")!;
    const variant = rows.find((r) => r.candidate === "variant")!;
    expect(baseline.status).toBe("judged"); // recorded, score 10 kept out
    expect(baseline.score).toBe(10);
    // Serial judging: the variant is now the live pending row for a 2nd pass.
    expect(variant.status).toBe("pending");
  });
});

describe("DoD 4 — sub-agent spawn/teardown via registry, respecting tier", () => {
  it("sequential tier (vram 4) reuses an already-loaded model and evicts before loading another", async () => {
    const h = await createSubAgentHarness({
      vramGb: 4,
      // runSubAgent unloads a model it loaded during its own call, so reuse is
      // observable only against a model already resident when the call starts.
      initiallyLoaded: ["lmstudio-community/gemma-3-270m-it-qat"],
      registry: [{ model_id: "lmstudio-community/gemma-3-270m-it-qat", roles: ["reviewer"], scores: { "task6-code-review-easy": 90 }, best_params: {}, last_tested: "x" }],
    });
    try {
      const first = await h.runAgent({ roles: ["reviewer"] });
      expect(first.loaded_this_call).toBe(false); // reused the resident model
      expect(first.unloaded).toBe(false); // did not load it, so did not unload it
      expect(h.counts.loads).toBe(0);

      const second = await h.runAgent({ roles: ["reviewer"] });
      expect(second.loaded_this_call).toBe(false); // still resident, reused again
      expect(h.counts.loads).toBe(0);

      // Sequential tier evicts the occupant before loading a different model.
      const third = await h.runAgent({ model_id: "other/model-1b", roles: ["reviewer"] });
      expect(third.evicted_instance_ids).toContain("lmstudio-community/gemma-3-270m-it-qat");
      expect(third.loaded_this_call).toBe(true);
      expect(third.unloaded).toBe(true); // eviction + own teardown, exactly once each
      expect(h.counts.loads).toBe(1);
      expect(h.counts.unloads).toBe(2);
    } finally {
      await h.close();
    }
  });

  it("run_sub_agent tool surfaces the structured result incl. token usage + validation", async () => {
    const h = await createPhase11Harness();
    try {
      const res = await h.callTool("run_sub_agent", {
        profile: "t",
        brief: "Summarize the fixture.",
        model_id: "gemma-3-270m-it-qat",
        roles: ["summarizer"],
      });
      expect(res.ok).toBe(true);
      const data = res.data as { reply: string; validation: { cleaned: boolean; issues: string[] }; token_usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } };
      expect(data.reply.length).toBeGreaterThan(0);
      expect(typeof data.token_usage.inputTokens).toBe("number");
    } finally {
      await h.close();
    }
  });
});

describe("DoD 5 — /nanites-cost-saved reports real logged usage", () => {
  let h: Phase11Harness;

  beforeEach(async () => {
    h = await createPhase11Harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("reports the tokens and USD the orchestrator did not spend", async () => {
    h.deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 1000, tokens_out: 500, duration_ms: 100 });
    const res = await h.callTool("get_cost_saved_report", { profile: "t" });
    expect(res.ok).toBe(true);
    const data = res.data as { calls: number; tokens_in: number; saved_usd: number };
    expect(data.calls).toBe(1);
    expect(data.tokens_in).toBe(1000);
    expect(data.saved_usd).toBeGreaterThan(0);
    expect(data.saved_usd).toBeCloseTo(1000 / 1_000_000 * 3 + 500 / 1_000_000 * 15, 6); // default pricing 3/15
  });
});

describe("DoD 6 — ntfy fires when configured, silently skips when not", () => {
  let h: Phase11Harness;

  beforeEach(async () => {
    h = await createPhase11Harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("no topic configured is a silent no-op, never an error", async () => {
    const res = await h.callTool("send_ntfy", { profile: "t", message: "hi" });
    expect(res.ok).toBe(true);
    expect((res.data as { sent: boolean; reason: string | null }).sent).toBe(false);
    expect((res.data as { reason: string | null }).reason).toBe("no_topic");
  });

  it("a topic configured returns the push result without failing the caller", async () => {
    // Point the push at the mock LM Studio as a stand-in HTTP server — the
    // profile's ntfy server_url is under our control; a live push attempt to
    // the mock returns non-2xx, which must still resolve (fire-and-forget).
    h.deps.profiles.updateProfile("t", { ntfy: { topic: "nanites-test", server_url: h.mock.url } });
    const res = await h.callTool("send_ntfy", { profile: "t", message: "hi" });
    expect(res.ok).toBe(true);
    const data = res.data as { sent: boolean };
    // It attempted a push; the result is a structured {sent, reason}, never a throw.
    expect(typeof data.sent).toBe("boolean");
  });
});

describe("DoD 7 — health check catches a dead endpoint before a workflow runs", () => {
  let h: Phase11Harness;

  beforeEach(async () => {
    h = await createPhase11Harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("system_health_check on a dead endpoint reports down with recovery attempted", async () => {
    // Kill the mock to make the endpoint refuse connections.
    await h.mock.close();
    const res = await h.callTool("system_health_check", { profile: "t" });
    expect(res.ok).toBe(true);
    const data = res.data as { overall: string; reachable: boolean; recovery_attempted: boolean };
    expect(data.overall).toBe("down");
    expect(data.reachable).toBe(false);
    // Autostart was attempted (the recovery step ran; it cannot succeed here).
    expect(data.recovery_attempted).toBe(true);
  });

  it("run_test_regimen aborts with a structured health error instead of wasting calls on a dead endpoint", async () => {
    await h.mock.close();
    const res = await h.callTool("run_test_regimen", { profile: "t", model_id: MODEL });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("health_check_failed");
    expect(res.error!.retryable).toBe(true);
  });
});

describe("DoD 8 — slash commands + skill cover the deterministic + inference split", () => {
  let h: Phase11Harness;

  beforeEach(async () => {
    h = await createPhase11Harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("all four slash commands are exposed as prompts and name deterministic tool chains", async () => {
    const prompts = await h.listPrompts();
    for (const name of ["nanites-new-profile", "nanites-switch-profile", "nanites-profiles", "nanites-cost-saved"]) {
      expect(prompts).toContain(name);
    }
  });

  it("companion SKILL.md exists and never asks Claude to compute what a script does", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const skillPath = path.join(process.cwd(), ".claude", "skills", "nanites", "SKILL.md");
    const text = fs.readFileSync(skillPath, "utf8");
    // No instruction to tally/count/recompute what a tool already returns.
    expect(text).not.toMatch(/count the profile|track token|compute.*cost|sum.*tokens|add up/i);
    // It points Claude at the tools that do the deterministic work.
    expect(text).toMatch(/run_sub_agent/);
    expect(text).toMatch(/get_pending_judgments/);
    expect(text).toMatch(/submit_test_judgment/);
    expect(text).toMatch(/check_adaptation/);
  });
});
