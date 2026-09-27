/**
 * Phase 31 (E gate) — item 2 + E2/E3: the selector integration. roleMatch
 * ranks on the role-keyed means finalize now writes (higher mean wins the same
 * tier); best-of-requested (Math.max over a multi-role match) is confirmed
 * intentional so it isn't "fixed" later; a role with no approved data never
 * outranks a scored role of the same tier. Then, end to end: run_sub_agent
 * surfaces low_confidence + a note when a matched role's score_minima is below
 * (or absent from) FITNESS_FLOOR — and stays silent above it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { findBestModel } from "../../src/workflows/roleMatch.js";
import { createSubAgentHarness, type SubAgentHarness } from "../phase8/helpers.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

function entry(modelId: string, roles: string[], scores: Record<string, number>, score_minima?: Record<string, number>): RegistryEntry {
  return { model_id: modelId, roles, scores, score_minima, best_params: {}, last_tested: "x" };
}

describe("Phase 31 — selector ranks role means; best-of-requested is intentional", () => {
  it("same tier: the higher role mean wins", () => {
    const a = entry("model-a", ["reviewer"], { reviewer: 90 });
    const b = entry("model-b", ["reviewer"], { reviewer: 60 });
    const picked = findBestModel([a, b], ["reviewer"]);
    expect(picked?.entry.model_id).toBe("model-a");
    expect(picked?.tier).toBe("exact");
  });

  it("E2 — multi-role best-of-requested: Math.max over matched roles, not a mean", () => {
    // If ranking averaged matched roles, model-b (reviewer 85) would beat
    // model-a (mean (90+40)/2 = 65). Best-of-requested surfaces model-a's
    // strongest matched role (90 > 85). Do not "fix" without revisiting E2.
    const a = entry("model-a", ["reviewer", "summarizer"], { reviewer: 90, summarizer: 40 });
    const b = entry("model-b", ["reviewer"], { reviewer: 85 });
    const picked = findBestModel([a, b], ["reviewer", "summarizer"]);
    expect(picked?.entry.model_id).toBe("model-a");
    expect(picked?.matched_roles).toEqual(["reviewer", "summarizer"]);
  });

  it("a matched role with no approved data does not outrank a scored role of the same tier", () => {
    const scored = entry("model-scored", ["reviewer"], { reviewer: 80 });
    const noData = entry("model-no-data", ["reviewer"], {});
    const picked = findBestModel([scored, noData], ["reviewer"]);
    expect(picked?.entry.model_id).toBe("model-scored");
  });
});

describe("Phase 31 — E3: run_sub_agent low-confidence signal", () => {
  const MODEL = "lmstudio-community/gemma-3-270m-it-qat";
  let h: SubAgentHarness | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it("a matched role whose score_minima is below the floor flags low_confidence with a note", async () => {
    h = await createSubAgentHarness({
      registry: [
        { model_id: MODEL, roles: ["reviewer"], scores: { reviewer: 80 }, score_minima: { reviewer: 40 }, best_params: {}, last_tested: "x" },
      ],
    });
    const res = await h.runAgent({ roles: ["reviewer"] });
    expect(res.model_id).toBe(MODEL); // selection unchanged — the flag is additive
    expect(res.role).toBe("reviewer");
    expect(res.low_confidence).toBe(true);
    expect(res.note).toMatch(/reviewer/);
  });

  it("a matched role with no approved minima (0 < floor) also flags low_confidence", async () => {
    h = await createSubAgentHarness({
      registry: [{ model_id: MODEL, roles: ["reviewer"], scores: { reviewer: 80 }, best_params: {}, last_tested: "x" }],
    });
    const res = await h.runAgent({ roles: ["reviewer"] });
    expect(res.low_confidence).toBe(true);
  });

  it("a matched role whose minima is at/above the floor stays unflagged", async () => {
    h = await createSubAgentHarness({
      registry: [
        { model_id: MODEL, roles: ["reviewer"], scores: { reviewer: 80 }, score_minima: { reviewer: 80 }, best_params: {}, last_tested: "x" },
      ],
    });
    const res = await h.runAgent({ roles: ["reviewer"] });
    expect(res.low_confidence).toBeUndefined();
    expect(res.note).toBeUndefined();
  });
});
