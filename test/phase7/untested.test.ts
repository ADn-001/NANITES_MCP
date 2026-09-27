import { describe, expect, it } from "vitest";
import { findUntestedModels, modelKey } from "../../src/workflows/untested.js";
import { listModelsFixture } from "../phase1/fixtures.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

const gemma = "gemma-3-270m-it-qat";
const nomic = "text-embedding-nomic-embed-text-v1.5-embedding";

function entry(model_id: string): RegistryEntry {
  return { model_id, roles: ["code_qa"], scores: {}, best_params: {}, last_tested: "2026-01-01T00:00:00.000Z" };
}

describe("Phase 7 gate — untested-model detection", () => {
  it("no registry: every LLM is untested, embeddings are not", () => {
    const untested = findUntestedModels(listModelsFixture.models, []);
    expect(untested.map(modelKey)).toContain(gemma);
    expect(untested.map(modelKey)).not.toContain(nomic);
  });

  it("registry with one model: only the unregistered LLM is untested", () => {
    const untested = findUntestedModels(listModelsFixture.models, [entry(gemma)]);
    expect(untested.map(modelKey)).not.toContain(gemma);
    expect(untested.map(modelKey)).not.toContain(nomic); // embedding never untested
    expect(untested).toHaveLength(0);
  });

  it("registry with an unrelated model: both LLMs still untested", () => {
    const untested = findUntestedModels(listModelsFixture.models, [entry("someone/else")]);
    expect(untested.map(modelKey)).toContain(gemma);
    expect(untested).toHaveLength(1);
  });
});
