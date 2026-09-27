/**
 * Phase 16 — dynamic_model OFF. When the toggle is off, run_sub_agent must use
 * the user's loaded LM Studio pool (no hot-load / evict / unload) and leave the
 * registry untouched, while still logging cost. ON (default) must keep hot-
 * loading exactly as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSubAgentHarness, type SubAgentHarness } from "../phase8/helpers.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

const GEM = "gemma-3-270m-it-qat";

function entry(
  modelId: string,
  roles: string[],
  scores: Record<string, number>,
  performance_score?: number,
): RegistryEntry {
  return { model_id: modelId, roles, scores, best_params: {}, last_tested: null, performance_score };
}

describe("dynamic_model OFF — loaded-pool selection", () => {
  let h: SubAgentHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("uses a single loaded registered model that role-matches, with no load/unload", async () => {
    h = await createSubAgentHarness({
      dynamicModel: false,
      initiallyLoaded: [GEM],
      registry: [entry(GEM, ["code_qa"], { code_qa: 90 })],
    });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.model_id).toBe(GEM);
    expect(res.loaded_this_call).toBe(false);
    expect(res.unloaded).toBe(false);
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
  });

  it("among multiple role-matching loaded models, prefers the higher performance_score", async () => {
    const A = "model-a";
    const B = "model-b";
    h = await createSubAgentHarness({
      dynamicModel: false,
      initiallyLoaded: [A, B],
      registry: [entry(A, ["code_qa"], { code_qa: 80 }, 70), entry(B, ["code_qa"], { code_qa: 60 }, 95)],
    });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.model_id).toBe(B); // higher performance_score wins
  });

  it("raises no_model_loaded when the pool is empty", async () => {
    h = await createSubAgentHarness({ dynamicModel: false, initiallyLoaded: [], registry: [] });
    await expect(h.runAgent({ roles: ["code_qa"] })).rejects.toMatchObject({ code: "no_model_loaded" });
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
  });

  it("falls back to any loaded model (unregistered included) when no role-match", async () => {
    h = await createSubAgentHarness({
      dynamicModel: false,
      initiallyLoaded: [GEM],
      registry: [], // nothing registered
    });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.model_id).toBe(GEM);
    expect(res.loaded_this_call).toBe(false);
  });

  it("stage-1 role-match beats a higher-scoring unregistered loaded model", async () => {
    const reg = "reg-model";
    const unreg = "unreg-model";
    h = await createSubAgentHarness({
      dynamicModel: false,
      initiallyLoaded: [reg, unreg],
      registry: [entry(reg, ["code_qa"], { code_qa: 50 }, 55)],
    });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.model_id).toBe(reg); // registered role-match preferred over unregistered
  });

  it("does not create or modify a registry entry", async () => {
    h = await createSubAgentHarness({
      dynamicModel: false,
      initiallyLoaded: [GEM],
      registry: [entry(GEM, ["code_qa"], { code_qa: 90 })],
    });
    await h.runAgent({ roles: ["code_qa"] });
    const before = h.deps.registry.list("t").length;
    // The entry's reasoning_type must not have been learned/written in OFF mode.
    const reg = h.deps.registry.get("t", GEM);
    // unlearned default — OFF mode must not write a learned reasoning_type
    expect(reg?.reasoning_type).toBe("unknown");
    expect(before).toBe(1); // unchanged — no upsert added a score/entry
  });

  it("still logs the call so the cost report stays accurate", async () => {
    h = await createSubAgentHarness({ dynamicModel: false, initiallyLoaded: [GEM], registry: [] });
    await h.runAgent({ roles: ["code_qa"] });
    expect(h.deps.callLogs.list("t", 100).length).toBe(1);
  });
});

describe("dynamic_model ON (default) still hot-loads", () => {
  let h: SubAgentHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("loads the registry match when nothing is resident", async () => {
    h = await createSubAgentHarness({ registry: [entry(GEM, ["code_qa"], { code_qa: 90 })] });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.loaded_this_call).toBe(true);
    expect(h.counts.loads).toBe(1);
  });
});
