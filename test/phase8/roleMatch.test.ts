/**
 * Phase 8 gate — deterministic registry role lookup (test suite item 8-1).
 * Exact-first, documented partial fallback, null on no match; ranking is
 * deterministic (tier weight, then best score, then model_id) so the answer
 * never depends on iteration order.
 */
import { describe, expect, it } from "vitest";
import { findBestModel, rolesFromBrief } from "../../src/workflows/roleMatch.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

function entry(modelId: string, roles: string[], scores: Record<string, number>): RegistryEntry {
  return { model_id: modelId, roles, scores, best_params: {}, last_tested: null };
}

const A = entry("a/summarizer", ["summarizer"], { summarizer: 80 });
const B = entry("b/qa", ["code_qa", "reviewer"], { code_qa: 90, reviewer: 70 });

describe("findBestModel", () => {
  it("exact role match picks the registered model", () => {
    const match = findBestModel([A, B], ["code_qa"]);
    expect(match).not.toBeNull();
    expect(match!.entry.model_id).toBe("b/qa");
    expect(match!.tier).toBe("exact");
    expect(match!.matched_roles).toEqual(["code_qa"]);
  });

  it("same tier: higher best score wins", () => {
    const C = entry("c/qa2", ["code_qa"], { code_qa: 95 });
    const match = findBestModel([A, B, C], ["code_qa"]);
    expect(match!.entry.model_id).toBe("c/qa2");
  });

  it("exact beats partial", () => {
    const partial = entry("p/sloppy", ["extractor"], { extractor: 99 });
    const match = findBestModel([partial, B], ["code_qa"]);
    expect(match!.entry.model_id).toBe("b/qa"); // exact, despite lower score
    expect(match!.tier).toBe("exact");
  });

  it("partial overlap is a documented fallback", () => {
    const match = findBestModel([A, B], ["code reviewer"]);
    expect(match).not.toBeNull();
    expect(match!.tier).toBe("partial");
    expect(match!.entry.model_id).toBe("b/qa");
    expect(match!.matched_roles).toContain("code_qa");
  });

  it("no overlap -> null (never a silent random pick)", () => {
    expect(findBestModel([A, B], ["poet"])).toBeNull();
  });

  it("empty registry or empty requested roles -> null", () => {
    expect(findBestModel([], ["code_qa"])).toBeNull();
    expect(findBestModel([A, B], [])).toBeNull();
    expect(findBestModel([A, B], ["  "])).toBeNull();
  });
});

describe("rolesFromBrief", () => {
  it("extracts reviewer from bug-hunting brief", () => {
    expect(rolesFromBrief("Please review this module for bugs")).toContain("reviewer");
  });

  it("extracts test_writer and code_writer from a scaffolding brief", () => {
    const roles = rolesFromBrief("write a unit test for the parser and generate the file");
    expect(roles).toContain("test_writer");
    expect(roles).toContain("code_writer");
  });

  it("returns empty when no keyword matches", () => {
    expect(rolesFromBrief("just ping me when it's done")).toEqual([]);
  });
});
