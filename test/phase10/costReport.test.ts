/**
 * Phase 10 gate — cost-saved report from real logged usage (item 1). Given a
 * hand-constructed call log with known token counts and a profile with known
 * rates, the reported USD delta must match a hand-computed value exactly.
 * Period windows are deterministic via an injectable `now`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { getCostSavedReport } from "../../src/workflows/costSavedReport.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const INPUT = 4;
const OUTPUT = 20;
const NOW = "2026-08-30T12:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const equiv = (ti: number, to: number): number => (ti / 1_000_000) * INPUT + (to / 1_000_000) * OUTPUT;

function isoAgo(msAgo: number): string {
  return new Date(new Date(NOW).getTime() - msAgo).toISOString();
}

describe("Phase 10 gate — cost saved report", () => {
  let deps: ToolDeps;
  let home: string;

  beforeEach(() => {
    home = scratchHome();
    deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t", pricing: { input_per_million_usd: INPUT, output_per_million_usd: OUTPUT } });
  });
  afterEach(() => {
    deps.close();
    cleanup(home);
  });

  it("matches a hand-computed delta exactly", () => {
    deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 1000, tokens_out: 500, duration_ms: 100, created_at: isoAgo(DAY) });
    deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 2000, tokens_out: 1000, duration_ms: 100, created_at: isoAgo(2 * 60 * 60 * 1000) });
    deps.callLogs.insert({ profile_name: "t", model_id: "m2", tokens_in: 500, tokens_out: 250, duration_ms: 100, created_at: isoAgo(60 * DAY) });

    const report = getCostSavedReport(deps, "t", { period: "all", now: NOW });
    expect(report.calls).toBe(3);
    expect(report.tokens_in).toBe(3500);
    expect(report.tokens_out).toBe(1750);
    expect(report.saved_usd).toBe(equiv(1000, 500) + equiv(2000, 1000) + equiv(500, 250));
    expect(report.orchestrator_equivalent_usd).toBe(report.saved_usd);
    // The note states the estimate's basis (the cloud-ledger work replaced the old
    // "cloud spend is ~$0" caveat with the saved/spent split). An all-local
    // profile spends nothing, which the report now says in numbers, not prose.
    expect(report.notes).toMatch(/actual_spend_usd/);
    expect(report.cloud_calls).toBe(0);
    expect(report.actual_spend_usd).toBe(0);
  });

  it("breaks down per model", () => {
    deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 1000, tokens_out: 500, duration_ms: 100, created_at: isoAgo(DAY) });
    deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 2000, tokens_out: 1000, duration_ms: 100, created_at: isoAgo(2 * 60 * 60 * 1000) });
    deps.callLogs.insert({ profile_name: "t", model_id: "m2", tokens_in: 500, tokens_out: 250, duration_ms: 100, created_at: isoAgo(60 * DAY) });

    const report = getCostSavedReport(deps, "t", { period: "all", now: NOW });
    expect(report.breakdown).toHaveLength(2);
    const m1 = report.breakdown.find((b) => b.model_id === "m1")!;
    const m2 = report.breakdown.find((b) => b.model_id === "m2")!;
    expect(m1.calls).toBe(2);
    expect(m1.tokens_in).toBe(3000);
    expect(m1.orchestrator_equivalent_usd).toBe(equiv(1000, 500) + equiv(2000, 1000));
    expect(m2.calls).toBe(1);
    expect(m2.orchestrator_equivalent_usd).toBe(equiv(500, 250));
  });

  it("period windows filter by created_at", () => {
    deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 1000, tokens_out: 500, duration_ms: 100, created_at: isoAgo(25 * 60 * 60 * 1000) }); // week yes, day no
    deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 2000, tokens_out: 1000, duration_ms: 100, created_at: isoAgo(2 * 60 * 60 * 1000) }); // day yes
    deps.callLogs.insert({ profile_name: "t", model_id: "m2", tokens_in: 500, tokens_out: 250, duration_ms: 100, created_at: isoAgo(60 * DAY) }); // excluded everywhere

    expect(getCostSavedReport(deps, "t", { period: "week", now: NOW }).calls).toBe(2);
    expect(getCostSavedReport(deps, "t", { period: "day", now: NOW }).calls).toBe(1);
    expect(getCostSavedReport(deps, "t", { period: "month", now: NOW }).calls).toBe(2);
    expect(getCostSavedReport(deps, "t", { period: "day", now: NOW }).saved_usd).toBe(equiv(2000, 1000));
  });

  it("empty log reports zero", () => {
    const report = getCostSavedReport(deps, "t", { period: "all", now: NOW });
    expect(report.calls).toBe(0);
    expect(report.saved_usd).toBe(0);
    expect(report.breakdown).toHaveLength(0);
  });

  it("unknown profile is a structured error", () => {
    expect(() => getCostSavedReport(deps, "nope", { now: NOW })).toThrow(/no profile named/i);
  });
});
