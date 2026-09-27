/**
 * Phase 9 gate — Workflow #3 diff+sweep (item 1) and Workflow #4 download→
 * auto-test chaining (item 4). The diff must identify only the unregistered
 * LLM subset, and a completed download must trigger Workflow #1 automatically.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createDownloadHarness, type DownloadHarness } from "./helpers.js";
import { runTestRegimen } from "../../src/workflows/runTestRegimen.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

const GEM_KEY = "gemma-3-270m-it-qat"; // load/list identifier (model key)
const GEM_SOURCE = "lmstudio-community/gemma-3-270m-it-qat"; // download source (HF repo id)
const OTHER = "openai/gpt-oss-20b";
const JUDGED_UNITS = 21;

function entry(modelId: string): RegistryEntry {
  return { model_id: modelId, roles: ["code_qa"], scores: { code_qa: 90 }, best_params: {}, last_tested: null };
}

describe("Phase 9 gate — Workflow #3 diff + sweep", () => {
  let h: DownloadHarness;

  afterEach(async () => {
    await h.close();
  });

  it("empty registry: every downloaded LLM is untested and gets swept", async () => {
    h = await createDownloadHarness({ registry: [] });
    const res = await h.sweep();
    expect(res.untested_count).toBe(1);
    expect(res.models).toEqual([GEM_KEY]);
    expect(res.summaries).toHaveLength(1);
    expect(res.summaries[0]!.model_id).toBe(GEM_KEY);
    expect(res.summaries[0]!.pending_unit_ids).toHaveLength(JUDGED_UNITS);
  });

  it("already-registered model is not untested (diff excludes it)", async () => {
    h = await createDownloadHarness({ registry: [entry(GEM_KEY)] });
    const res = await h.sweep();
    expect(res.untested_count).toBe(0);
    expect(res.summaries).toHaveLength(0);
  });

  it("partial overlap: registry entries for models not on the endpoint do not hide untested ones", async () => {
    h = await createDownloadHarness({ registry: [entry(OTHER)] });
    const res = await h.sweep();
    expect(res.untested_count).toBe(1);
    expect(res.models).toEqual([GEM_KEY]);
  });
});

describe("Phase 9 gate — Workflow #4 download then auto-test", () => {
  let h: DownloadHarness;

  afterEach(async () => {
    await h.close();
  });

  it("completed download triggers Workflow #1 automatically", async () => {
    h = await createDownloadHarness({ downloadStatuses: ["downloading", "completed"] });
    const res = await h.test(GEM_SOURCE);
    expect(res.download.status).toBe("completed");
    expect(res.download.polls).toBe(2);
    expect(res.regimen).not.toBeNull();
    expect(res.regimen!.model_id).toBe(GEM_SOURCE);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
  });

  it("failed download returns without running a regimen", async () => {
    h = await createDownloadHarness({ downloadStatuses: ["downloading", "failed"] });
    const res = await h.test(GEM_SOURCE);
    expect(res.download.status).toBe("failed");
    expect(res.regimen).toBeNull();
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
  });
});

describe("Phase 9 gate — regimen acquire/release (no duplicate instances)", () => {
  let h: DownloadHarness;

  afterEach(async () => {
    await h.close();
  });

  it("target already resident: regimen reuses the instance, never reloads or unloads it", async () => {
    h = await createDownloadHarness({ residentGemma: true });
    const res = await runTestRegimen(h.deps, "t", GEM_KEY);
    expect(res.model_id).toBe(GEM_KEY);
    // The user's resident copy (:1) is reused — no fresh :2 duplicate, and it
    // is NOT torn down afterwards. This is the fix for the idle-copy churn.
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
  });

  it("different occupant on a sequential tier: evict it once, load once, unload only what we loaded", async () => {
    h = await createDownloadHarness({ residentGemma: true });
    const res = await runTestRegimen(h.deps, "t", OTHER);
    expect(res.model_id).toBe(OTHER);
    // Evict the resident gemma to free the single slot (1), then unload our own
    // freshly loaded instance (2). Never leaves the tested clone competing with
    // an idle copy for VRAM.
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(2);
  });

  it("fresh endpoint: one load for the pass, one unload after — no per-test cycling", async () => {
    h = await createDownloadHarness({ residentGemma: false });
    const res = await runTestRegimen(h.deps, "t", GEM_SOURCE);
    expect(res.model_id).toBe(GEM_SOURCE);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    expect(h.loaded()).toEqual({});
  });

  it("dynamic profile + JIT sibling: teardown evicts BOTH instances of the key, none left resident", async () => {
    h = await createDownloadHarness({ jitDuplicate: true });
    const res = await runTestRegimen(h.deps, "t", GEM_SOURCE);
    expect(res.model_id).toBe(GEM_SOURCE);
    // One explicit load, then the regimen unloads the key-wide pair it saw
    // (our instance + the JIT `<key>:1` twin) — the orphan fix.
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(2);
    expect(h.loaded()).toEqual({});
  });

  it("non-dynamic profile + JIT sibling: legacy unload hits only our own instance, user's twin stays resident", async () => {
    h = await createDownloadHarness({ jitDuplicate: true, dynamicModel: false });
    const res = await runTestRegimen(h.deps, "t", GEM_SOURCE);
    expect(res.model_id).toBe(GEM_SOURCE);
    // Only the id this run loaded is torn down; the preconfigured resident twin
    // (`<key>:1`) is not ours to reclaim on a non-dynamic profile.
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    expect(h.loaded()).toEqual({ [GEM_SOURCE]: [`${GEM_SOURCE}:1`] });
  });
});
