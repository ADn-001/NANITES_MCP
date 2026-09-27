/**
 * Effort-triad sprint — planner wiring through run_sub_agent. Asserts the
 * inference planner's decisions (output budget, reasoning flag, load context)
 * actually reach the mock LM Studio request bodies, that per-call `effort`
 * overrides the profile default, and that the removed params are rejected at
 * the tool schema layer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSubAgentHarness, type SubAgentHarness } from "../phase8/helpers.js";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

const GEM = "gemma-3-270m-it-qat"; // non-reasoning name seed -> "unknown" -> treated capable

function entry(modelId: string, roles: string[], scores: Record<string, number>): RegistryEntry {
  return { model_id: modelId, roles, scores, best_params: {}, last_tested: null };
}

function isMultipleOf512(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n % 512 === 0;
}

describe("run_sub_agent — planner params reach the wire", () => {
  let h: SubAgentHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("low effort sends a 1/8-ceiling budget and suppresses thinking (reasoning 'off')", async () => {
    h = await createSubAgentHarness({ registry: [entry(GEM, ["code_qa"], { code_qa: 90 })] });
    await h.runAgent({ roles: ["code_qa"], effort: "low" });
    const chat = h.lastChat()!;
    expect(chat.max_output_tokens).toBe(1024); // 8192 / 8
    expect(chat.reasoning).toBe("off");
    const load = h.lastLoad()!;
    expect(isMultipleOf512(load.context_length as number)).toBe(true);
    expect(load.context_length).toBeLessThanOrEqual(4096); // mock max_context_length
  });

  it("high effort sends the full ceiling and a reasoning flag for a difficult role", async () => {
    h = await createSubAgentHarness({ registry: [entry(GEM, ["code_qa"], { code_qa: 90 })] });
    await h.runAgent({ roles: ["code_qa"], effort: "high" });
    const chat = h.lastChat()!;
    expect(chat.max_output_tokens).toBe(8192);
    expect(chat.reasoning).toBe("on");
  });

  it("effort low vs high produce different output budgets", async () => {
    h = await createSubAgentHarness({ registry: [entry(GEM, ["code_qa"], { code_qa: 90 })] });
    await h.runAgent({ roles: ["code_qa"], effort: "low" });
    const low = h.lastChat()!.max_output_tokens as number;
    await h.runAgent({ roles: ["code_qa"], effort: "high" });
    const high = h.lastChat()!.max_output_tokens as number;
    expect(high).toBeGreaterThan(low);
  });

  it("load request carries the planner's context_length", async () => {
    h = await createSubAgentHarness({ registry: [entry(GEM, ["code_qa"], { code_qa: 90 })] });
    await h.runAgent({ roles: ["code_qa"], effort: "high" });
    const load = h.lastLoad()!;
    expect(typeof load.context_length).toBe("number");
  });

  it("reasoning_type learned from chat stats survives the run (score upsert does not clobber it)", async () => {
    h = await createSubAgentHarness({
      registry: [entry(GEM, ["code_qa"], { code_qa: 90 })],
      reasoningOutputTokens: 500,
    });
    await h.runAgent({ roles: ["code_qa"], effort: "high" });
    // The chat reported reasoning tokens, so the run should have persisted
    // reasoning_type=reasoning — and the post-run performance-score upsert
    // must not overwrite it back to "unknown".
    expect(h.deps.registry.get("t", GEM)?.reasoning_type).toBe("reasoning");
  });
});

describe("run_sub_agent — tool schema rejects removed params, accepts effort", () => {
  let h: ToolHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("rejects the removed reasoning param", async () => {
    h = await createHarness();
    const raw = await h.callToolRaw("run_sub_agent", {
      profile: "t",
      model_id: GEM,
      brief: "x",
      reasoning: "on",
    });
    expect(raw.isError).toBe(true);
  });

  it("rejects the removed max_output_tokens param", async () => {
    h = await createHarness();
    const raw = await h.callToolRaw("run_sub_agent", {
      profile: "t",
      model_id: GEM,
      brief: "x",
      max_output_tokens: 500,
    });
    expect(raw.isError).toBe(true);
  });

  it("accepts effort and applies it", async () => {
    h = await createHarness();
    const res = await h.callTool("run_sub_agent", {
      profile: "t",
      model_id: GEM,
      brief: "Summarize this.",
      effort: "low",
    });
    expect(res.ok).toBe(true);
  });
});
