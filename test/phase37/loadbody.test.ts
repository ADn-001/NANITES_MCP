/**
 * Phase CP-3 gate — every Nanites-initiated native load carries the profile's
 * concurrency pair as `parallel` (the CP-1-probed load key), so forced
 * sequential tiers load with 1 slot and parallel tiers carry their pair.
 * Covers the two native load-body builders: acquireModel (shared by
 * run_sub_agent / btw held-instance / context-compaction) and run_test_regimen's
 * ensureContext. load_model additionally validates an explicit num_parallel
 * against the active tier.
 */
import { describe, expect, it } from "vitest";
import { createSubAgentHarness } from "../phase8/helpers.js";
import { createRegimenHarness } from "../phase7/helpers.js";
import { createHarness } from "../phase5/helpers.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

const GEM = "lmstudio-community/gemma-3-270m-it-qat";
const OSS = "openai/gpt-oss-20b";

function entry(modelId: string, roles: string[], scores: Record<string, number>): RegistryEntry {
  return { model_id: modelId, roles, scores, best_params: {}, last_tested: null };
}

describe("CP-3 acquireModel (runSubAgent path) sends the profile pair", () => {
  it("sequential profile (default, 1x1) loads with parallel=1", async () => {
    const h = await createSubAgentHarness({
      registry: [entry(OSS, ["code_qa"], { code_qa: 90 })],
    });
    await h.runAgent({ roles: ["code_qa"] });
    const body = h.lastLoad() as Record<string, unknown>;
    expect(body.parallel).toBe(1);
    await h.close();
  });

  it("high tier (2x2) loads with parallel=2", async () => {
    const h = await createSubAgentHarness({
      vramGb: 16,
      registry: [entry(OSS, ["code_qa"], { code_qa: 90 })],
    });
    await h.runAgent({ roles: ["code_qa"] });
    expect((h.lastLoad() as Record<string, unknown>).parallel).toBe(2);
    await h.close();
  });

  it("ultra override to 4x4 loads with parallel=4", async () => {
    const h = await createSubAgentHarness({
      vramGb: 40,
      registry: [entry(OSS, ["code_qa"], { code_qa: 90 })],
    });
    h.deps.profiles.updateProfile("t", { concurrency_override: { max_parallel_models: 4, num_parallel: 4 } });
    await h.runAgent({ roles: ["code_qa"] });
    expect((h.lastLoad() as Record<string, unknown>).parallel).toBe(4);
    await h.close();
  });
});

describe("CP-3 runTestRegimen ensureContext sends the profile pair", () => {
  it("sequential profile loads with parallel=1 on every load", async () => {
    const h = await createRegimenHarness({ replies: () => "ok" });
    const fixtureKey = GEM;
    await h.runRegimen(fixtureKey);
    expect(h.counts.loads).toBeGreaterThan(0);
    expect((h.lastLoad as Record<string, unknown> | undefined)?.parallel).toBe(1);
    await h.close();
  });

  it("high tier (vram 16) loads with parallel=2", async () => {
    const h = await createRegimenHarness({ replies: () => "ok" });
    h.deps.profiles.updateProfile("t", { machine_specs: { vram_gb: 16 } });
    await h.runRegimen(GEM);
    expect((h.lastLoad as Record<string, unknown> | undefined)?.parallel).toBe(2);
    await h.close();
  });

  it("ultra override to 4x4 loads with parallel=4", async () => {
    const h = await createRegimenHarness({ replies: () => "ok" });
    h.deps.profiles.updateProfile("t", {
      machine_specs: { vram_gb: 32 },
      concurrency_override: { max_parallel_models: 4, num_parallel: 4 },
    });
    await h.runRegimen(GEM);
    expect((h.lastLoad as Record<string, unknown> | undefined)?.parallel).toBe(4);
    await h.close();
  });
});

describe("CP-3 load_model validates an explicit num_parallel against the tier", () => {
  it("accepts an in-set slot on the high tier", async () => {
    const h = await createHarness();
    h.deps.profiles.updateProfile("t", { machine_specs: { vram_gb: 16 } });
    const res = await h.callTool("load_model", {
      model_id: GEM,
      params: { num_parallel: 2 },
    });
    expect(res.ok).toBe(true);
    await h.close();
  });

  it("rejects a 4-slot request on the high tier (only 2 allowed)", async () => {
    const h = await createHarness();
    h.deps.profiles.updateProfile("t", { machine_specs: { vram_gb: 16 } });
    const res = await h.callTool("load_model", {
      model_id: GEM,
      params: { num_parallel: 4 },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("concurrency_override_invalid");
    await h.close();
  });

  it("accepts 4 slots on the ultra tier", async () => {
    const h = await createHarness();
    h.deps.profiles.updateProfile("t", { machine_specs: { vram_gb: 32 } });
    const res = await h.callTool("load_model", {
      model_id: GEM,
      params: { num_parallel: 4 },
    });
    expect(res.ok).toBe(true);
    await h.close();
  });

  it("rejects any slot above 1 on a forced sequential tier", async () => {
    const h = await createHarness();
    // Profile stays vram_gb=4 (forced sequential).
    const res = await h.callTool("load_model", {
      model_id: GEM,
      params: { num_parallel: 2 },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("concurrency_override_invalid");
    await h.close();
  });

  it("loads with the tier default when no num_parallel is passed", async () => {
    const h = await createHarness();
    const res = await h.callTool("load_model", { model_id: GEM });
    expect(res.ok).toBe(true);
    await h.close();
  });
});
