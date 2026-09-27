/**
 * Phase 6 gate — health checker (test suite item 1).
 *
 * Table-driven runHealthCheck with injected recovery + disk inputs so every
 * overall status is reachable deterministically without touching a real LM
 * Studio process. The HTTP client itself is already gated in Phase 1; here we
 * substitute a fake listModels so we control reachability per call, and an
 * injected recovery/disk for the autostart and disk paths.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LmStudioClient } from "../../src/lmstudio/client.js";
import { runHealthCheck, DISK_LOW_THRESHOLD_GB, type HealthReport } from "../../src/health/checker.js";
import type { ListModelsResponse } from "../../src/lmstudio/types.js";
import { listModelsFixture } from "../phase1/fixtures.js";
import { sendJson, startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";

/** A fake client whose listModels behavior is switched per case. */
function fakeClient(listModels: () => Promise<ListModelsResponse>): LmStudioClient {
  return { listModels } as unknown as LmStudioClient;
}

function noopRecovery(waitMs = 0) {
  return { run: async () => {}, waitMs };
}

describe("Phase 6 gate — runHealthCheck", () => {
  let mock: MockLmStudio;

  beforeAll(async () => {
    mock = await startMockLmStudio((req, res) => sendJson(res, 200, listModelsFixture));
  });
  afterAll(async () => {
    await mock.close();
  });

  it("reachable + healthy: endpoint ok, disk ok, no recovery, overall healthy", async () => {
    const client = fakeClient(async () => listModelsFixture);
    const report: HealthReport = await runHealthCheck({
      profile: "t",
      client,
      recovery: noopRecovery(),
      disk: { availableGb: 100 },
    });
    expect(report.overall).toBe("healthy");
    expect(report.reachable).toBe(true);
    expect(report.recovery_attempted).toBe(false);
    expect(report.recovery_succeeded).toBeNull();
    expect(report.checks).toEqual({ endpoint: "ok", disk: "ok", loaded: "ok" });
    expect(report.disk.low).toBe(false);
    expect(report.loaded_models).toContain("gemma-3-270m-it-qat");
    expect(report.reason).toContain("endpoint reachable");
  });

  it("unreachable + autostart succeeds: recovery runs, recheck passes, healthy", async () => {
    let recovered = false;
    const client = fakeClient(async () => {
      if (!recovered) throw new Error("connection refused");
      return listModelsFixture;
    });
    const recovery = { run: async () => { recovered = true; }, waitMs: 0 };
    const report = await runHealthCheck({ profile: "t", client, recovery, disk: { availableGb: 100 } });
    expect(report.overall).toBe("healthy");
    expect(report.reachable).toBe(true);
    expect(report.recovery_attempted).toBe(true);
    expect(report.recovery_succeeded).toBe(true);
    expect(report.reason).toContain("recovered via autostart");
  });

  it("unreachable + autostart fails: recovery runs, recheck still fails, down", async () => {
    const client = fakeClient(async () => {
      throw new Error("connection refused");
    });
    const recovery = { run: async () => {}, waitMs: 0 };
    const report = await runHealthCheck({ profile: "t", client, recovery, disk: { availableGb: 100 } });
    expect(report.overall).toBe("down");
    expect(report.reachable).toBe(false);
    expect(report.recovery_attempted).toBe(true);
    expect(report.recovery_succeeded).toBe(false);
    expect(report.checks.endpoint).toBe("unreachable");
    expect(report.reason).toContain("endpoint unreachable after autostart attempt");
  });

  it("reachable but disk below threshold: degraded, disk low", async () => {
    const client = fakeClient(async () => listModelsFixture);
    const report = await runHealthCheck({
      profile: "t",
      client,
      recovery: noopRecovery(),
      disk: { availableGb: DISK_LOW_THRESHOLD_GB - 1 },
    });
    expect(report.overall).toBe("degraded");
    expect(report.checks.disk).toBe("low");
    expect(report.disk.low).toBe(true);
    expect(report.disk.available_gb).toBe(DISK_LOW_THRESHOLD_GB - 1);
    expect(report.reason).toContain("free disk below");
  });

  it("reachable but a loaded model is stuck: degraded, stuck_models populated", async () => {
    const stuckFixture: ListModelsResponse = structuredClone(listModelsFixture);
    // Loaded instance whose config is missing context_length — the wedged-model
    // heuristic.
    stuckFixture.models[0]!.loaded_instances[0]!.config = { eval_batch_size: 512 } as never;
    const client = fakeClient(async () => stuckFixture);
    const report = await runHealthCheck({
      profile: "t",
      client,
      recovery: noopRecovery(),
      disk: { availableGb: 100 },
    });
    expect(report.overall).toBe("degraded");
    expect(report.checks.loaded).toBe("stuck");
    expect(report.stuck_models).toContain("gemma-3-270m-it-qat");
    expect(report.reason).toContain("stuck-loaded models");
  });

  it("healthy model is not flagged as stuck", async () => {
    const client = fakeClient(async () => listModelsFixture);
    const report = await runHealthCheck({
      profile: "t",
      client,
      recovery: noopRecovery(),
      disk: { availableGb: 100 },
    });
    expect(report.stuck_models).toHaveLength(0);
  });

  it("profile is echoed through and every sub-field present", async () => {
    const client = fakeClient(async () => listModelsFixture);
    const report = await runHealthCheck({
      profile: "some-profile",
      client,
      recovery: noopRecovery(),
      disk: { availableGb: 100 },
    });
    expect(report.profile).toBe("some-profile");
    expect(report.disk.threshold_gb).toBe(DISK_LOW_THRESHOLD_GB);
    expect(report.disk.available_gb).toBe(100);
  });

  it("works against a live mock endpoint (real client, happy path)", async () => {
    const client = new LmStudioClient({ baseUrl: mock.url });
    const report = await runHealthCheck({ profile: "t", client, recovery: noopRecovery(), disk: { availableGb: 100 } });
    expect(report.reachable).toBe(true);
    expect(report.overall).toBe("healthy");
  });
});
