/**
 * Phase 10 gate — cost report + adaptation tools over the MCP surface. The
 * previously-stubbed get_cost_saved_report now returns a real report from
 * logged usage; check_adaptation and register_adapted_units exercise the
 * use-case-adaptation flow end to end through tools/call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import type { TestUnit } from "../../src/testunits/schema.js";

const validUnit: TestUnit = {
  id: "custom-1",
  name: "custom classifier unit",
  task_group: "custom",
  difficulty: "easy",
  prompts: [{ id: "p1", text: "Classify as exactly one of: BUG, FEATURE. Respond with only the label.\n\n\"export my data\"" }],
  measures: ["format_compliance"],
  applicable_roles: ["classifier"],
  recommended_config: { context_length: 2000, kv_cache_quant: "Q4", temperature: 0, top_p: 1, top_k: 1, repeat_penalty: 1, max_output_tokens: 10 },
  scoring: { method: "deterministic_rule", rule: { type: "exact_match", params: { expected: "FEATURE" } } },
  source: "custom_authored",
  version: 1,
};

describe("Phase 10 gate — cost + adaptation tools", () => {
  let h: ToolHarness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("get_cost_saved_report reports real logged usage at profile rates", async () => {
    h.deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 1000, tokens_out: 500, duration_ms: 100 });
    const res = await h.callTool("get_cost_saved_report", { profile: "t" });
    expect(res.ok).toBe(true);
    const data = res.data as { calls: number; tokens_in: number; saved_usd: number };
    expect(data.calls).toBe(1);
    expect(data.tokens_in).toBe(1000);
    // Default pricing 3/15.
    expect(data.saved_usd).toBeCloseTo(1000 / 1_000_000 * 3 + 500 / 1_000_000 * 15, 6);
  });

  it("get_cost_saved_report honors the period filter", async () => {
    h.deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 10, tokens_out: 10, duration_ms: 100 });
    const res = await h.callTool("get_cost_saved_report", { profile: "t", period: "day" });
    expect(res.ok).toBe(true);
    expect((res.data as { calls: number }).calls).toBe(1);
  });

  it("check_adaptation stays quiet for nanites-default, prompts otherwise", async () => {
    h.deps.profiles.createProfile({ name: "custom", use_case: "customer-support" });

    const silent = await h.callTool("check_adaptation", { profile: "t" });
    expect(silent.ok).toBe(true);
    expect((silent.data as { needs_adaptation: boolean }).needs_adaptation).toBe(false);

    const prompted = await h.callTool("check_adaptation", { profile: "custom" });
    expect(prompted.ok).toBe(true);
    const data = prompted.data as { needs_adaptation: boolean; prompt: string | null; default_plan_notice: string | null };
    expect(data.needs_adaptation).toBe(true);
    expect(data.prompt).toMatch(/customer-support/);
    expect(data.default_plan_notice).toMatch(/may not be well-calibrated/);
  });

  it("register_adapted_units validates before registering, surfacing rejections", async () => {
    const invalid = { ...validUnit, id: "custom-2", scoring: { method: "orchestrator_judged", rubric: "x" } };
    const res = await h.callTool("register_adapted_units", { profile: "t", units: [validUnit, invalid] });
    expect(res.ok).toBe(true);
    const data = res.data as { registered: number; rejected: Array<{ id: string; issues: string[] }> };
    expect(data.registered).toBe(1);
    expect(data.rejected).toHaveLength(1);
    expect(data.rejected[0]!.id).toBe("custom-2");
    expect(h.deps.testUnits.list("t").map((u) => u.id)).toEqual(["custom-1"]);
  });
});
