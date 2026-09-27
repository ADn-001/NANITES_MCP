/**
 * Phase CP-3 gate — advisory fallback: when LOAD_NUMPARALLEL_KEY is null (an LM
 * Studio build that rejects the `parallel` key), no Nanites-initiated load body
 * carries it — bodies are byte-identical to the pre-hardening shape and nothing
 * breaks (per the plan's "never a broken load, never a silent assumption").
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/helpers/concurrency.js", () => ({
  LOAD_NUMPARALLEL_KEY: null,
  concurrencyLoadExtras: () => ({}),
}));

import { createSubAgentHarness } from "../phase8/helpers.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

function entry(modelId: string, roles: string[], scores: Record<string, number>): RegistryEntry {
  return { model_id: modelId, roles, scores, best_params: {}, last_tested: null };
}

describe("CP-3 null gate — no parallel key on load bodies", () => {
  it("sequential load body omits parallel entirely", async () => {
    const h = await createSubAgentHarness({
      registry: [entry("openai/gpt-oss-20b", ["code_qa"], { code_qa: 90 })],
    });
    await h.runAgent({ roles: ["code_qa"] });
    const body = h.lastLoad() as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel");
    expect(body.model).toBe("openai/gpt-oss-20b");
    await h.close();
  });

  it("ultra-tier load body omits parallel entirely (no slot forcing)", async () => {
    const h = await createSubAgentHarness({
      vramGb: 40,
      registry: [entry("openai/gpt-oss-20b", ["code_qa"], { code_qa: 90 })],
    });
    h.deps.profiles.updateProfile("t", { concurrency_override: { max_parallel_models: 4, num_parallel: 4 } });
    await h.runAgent({ roles: ["code_qa"] });
    const body = h.lastLoad() as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel");
    await h.close();
  });
});
