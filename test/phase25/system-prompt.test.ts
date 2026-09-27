/**
 * Phase 16 Part C — buildSystemPrompt. Layers the persistent profile base under
 * identity/scope/role; adds a reasoning note for capable models; omits the tool
 * block when no manifest is attached.
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, type SystemPromptInput } from "../../src/helpers/systemPromptPlanner.js";

const base: SystemPromptInput = {
  profile: {
    use_case: "nanites-default",
    machine_specs: { vram_gb: 4, gpu: "GTX 1650" },
    concurrency: { mode: "sequential", max_parallel_models: 1, num_parallel: 1 },
    effort: "medium",
    dynamic_model: true,
    system_prompt: null,
  },
  role: "summarizer",
  modelId: "gemma-3-270m-it-qat",
  reasoningType: "non_reasoning",
};

describe("buildSystemPrompt", () => {
  it("includes identity, scope, role, and effort", () => {
    const sp = buildSystemPrompt(base);
    expect(sp).toContain("sub-agent on a local workstation");
    expect(sp).toContain('use-case "nanites-default"');
    expect(sp).toContain("4GB VRAM");
    expect(sp).toContain("sequential 1x1, one inference at a time");
    expect(sp).toContain("summarizer");
    expect(sp).toContain("Effort level: medium");
  });

  it("phrases a parallel-tier pair from the resolved concurrency", () => {
    const sp = buildSystemPrompt({
      ...base,
      profile: { ...base.profile, concurrency: { mode: "parallel", max_parallel_models: 2, num_parallel: 2 } },
    });
    expect(sp).toContain("parallel 2x2");
    expect(sp).not.toContain("single-model");
  });

  it("lays the persistent profile system_prompt at the top", () => {
    const sp = buildSystemPrompt({ ...base, profile: { ...base.profile, system_prompt: "You are a stern reviewer." } });
    expect(sp.startsWith("You are a stern reviewer.")).toBe(true);
  });

  it("adds a reasoning note for a reasoning-capable model", () => {
    const sp = buildSystemPrompt({ ...base, reasoningType: "reasoning" });
    expect(sp).toContain("Reason before answering when the task warrants it.");
  });

  it("omits the reasoning note for a non-reasoning model", () => {
    const sp = buildSystemPrompt(base);
    expect(sp).not.toContain("Reason before answering");
  });

  it("includes the tool manifest only when attached", () => {
    const withTools = buildSystemPrompt({ ...base, toolManifest: [{ name: "read_file", description: "read" }] });
    expect(withTools).toContain("read_file");
    const without = buildSystemPrompt(base);
    expect(without).not.toContain("read_file");
  });
});
