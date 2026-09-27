/**
 * Phase 34 gate (Phase G, G-3) — live-VRAM-aware guardrail tiering. A
 * constrained-VRAM fixture downgrades the effective tier with a human reason;
 * absent a live VRAM source (the Phase B probe found none), behavior matches
 * today: static machine-spec tier + a recorded note, never a fabricated number.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveGuardrailAdvice } from "../../src/guardrails/advisor.js";
import { runHealthCheck } from "../../src/health/checker.js";
import { sampleLiveFreeVram } from "../../src/helpers/liveVram.js";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import { listModelsFixture } from "../phase1/fixtures.js";
import type { LmStudioClient } from "../../src/lmstudio/client.js";

function fakeClient(): LmStudioClient {
  return { listModels: async () => listModelsFixture } as unknown as LmStudioClient;
}

const noopRecovery = { run: async () => {}, waitMs: 0 };

describe("Phase 34 — effectiveGuardrailAdvice (pure)", () => {
  it("constrained live free VRAM downgrades the effective tier with a human reason", () => {
    const advice = effectiveGuardrailAdvice({ vram_gb: 6 }, 3);
    expect(advice.downgraded).toBe(true);
    expect(advice.spec_tier).toBe("mid");
    expect(advice.effective_tier).toBe("baseline");
    expect(advice.vram_source).toBe("live_free");
    expect(advice.mode).toBe("sequential");
    expect(advice.reason).toContain("live free VRAM is 3GB");
    expect(advice.reason).toMatch(/lowered from mid to baseline/);
  });

  it("adequate live free VRAM does not downgrade", () => {
    const advice = effectiveGuardrailAdvice({ vram_gb: 6 }, 8);
    expect(advice.downgraded).toBe(false);
    expect(advice.effective_tier).toBe("mid");
    expect(advice.reason).toMatch(/no downgrade/);
  });

  it("never raises above the machine-spec tier", () => {
    const advice = effectiveGuardrailAdvice({ vram_gb: 4 }, 100);
    expect(advice.downgraded).toBe(false);
    expect(advice.effective_tier).toBe("baseline");
  });

  it("no live VRAM source: static tier + recorded note (matches today)", () => {
    const advice = effectiveGuardrailAdvice({ vram_gb: 4 }, null);
    expect(advice.downgraded).toBe(false);
    expect(advice.spec_tier).toBe("baseline");
    expect(advice.effective_tier).toBe("baseline");
    expect(advice.vram_source).toBe("static");
    expect(advice.reason).toContain("no live VRAM surface");
  });
});

describe("Phase 34 — runHealthCheck hardware advisory", () => {
  it("a constrained-VRAM fixture downgrades the report's effective tier", async () => {
    const report = await runHealthCheck({
      profile: "t",
      client: fakeClient(),
      recovery: noopRecovery,
      disk: { availableGb: 100 },
      hardware: { vram_gb: 12, live_free_vram_gb: 8 },
    });
    expect(report.overall).toBe("healthy");
    expect(report.guardrail_tier?.downgraded).toBe(true);
    expect(report.guardrail_tier?.spec_tier).toBe("high");
    expect(report.guardrail_tier?.effective_tier).toBe("mid");
    expect(report.guardrail_tier?.reason).toMatch(/lowered from high to mid/);
  });

  it("no live VRAM source -> static tier, behavior matches today", async () => {
    const report = await runHealthCheck({
      profile: "t",
      client: fakeClient(),
      recovery: noopRecovery,
      disk: { availableGb: 100 },
      hardware: { vram_gb: 4, live_free_vram_gb: null },
    });
    expect(report.guardrail_tier?.downgraded).toBe(false);
    expect(report.guardrail_tier?.effective_tier).toBe("baseline");
    expect(report.guardrail_tier?.reason).toContain("no live VRAM surface");
  });

  it("without hardware context the report carries no guardrail_tier (today's shape)", async () => {
    const report = await runHealthCheck({ profile: "t", client: fakeClient(), recovery: noopRecovery, disk: { availableGb: 100 } });
    expect(report.guardrail_tier).toBeUndefined();
  });
});

describe("Phase 34 — sampler + system_health_check integration", () => {
  let h: ToolHarness;

  beforeAll(async () => {
    h = await createHarness(); // profile "t", vram_gb 4, reachable mock endpoint
  });
  afterAll(async () => {
    await h.close();
  });

  it("the live-VRAM sampler reports no source on this build", async () => {
    const sample = await sampleLiveFreeVram();
    expect(sample.free_vram_gb).toBeNull();
    expect(sample.source).toBe("static");
  });

  it("system_health_check carries the static-tier advisory with a recorded note", async () => {
    const res = await h.callTool("system_health_check", { profile: "t" });
    expect(res.ok).toBe(true);
    const data = res.data as { reachable: boolean; guardrail_tier: { effective_tier: string; downgraded: boolean; reason: string } };
    // Endpoint reachability is the mock's to decide; the G-3 concern is the
    // advisory, which must ride along regardless of the disk/overall verdict.
    expect(data.reachable).toBe(true);
    expect(data.guardrail_tier.downgraded).toBe(false);
    expect(data.guardrail_tier.effective_tier).toBe("baseline");
    expect(data.guardrail_tier.reason).toContain("no live VRAM surface");
  });
});
