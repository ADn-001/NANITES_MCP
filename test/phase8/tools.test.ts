/**
 * Phase 8 gate — run_sub_agent exposed over the MCP surface (schema
 * validation + structured envelope end to end, exactly as Claude would call
 * it). Server-side role lookup and concurrency enforcement are exercised via
 * the same tools/call path used in production.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

const GEM = "gemma-3-270m-it-qat";
const OSS = "openai/gpt-oss-20b";

function entry(modelId: string, roles: string[], scores: Record<string, number>): RegistryEntry {
  return { model_id: modelId, roles, scores, best_params: {}, last_tested: null };
}

describe("Phase 8 gate — run_sub_agent tool", () => {
  let h: ToolHarness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("reuses an already-loaded model and returns the reply envelope", async () => {
    const res = await h.callTool("run_sub_agent", { profile: "t", model_id: GEM, brief: "Summarize this." });
    expect(res.ok).toBe(true);
    const data = res.data as { model_id: string; loaded_this_call: boolean; reply: string; validation: { cleaned: boolean; issues: string[] }; call_log_id: number };
    expect(data.model_id).toBe(GEM);
    expect(data.loaded_this_call).toBe(false);
    expect(data.reply.length).toBeGreaterThan(0);
    expect(data.validation).toBeDefined();
    expect(data.call_log_id).toBeGreaterThan(0);
    const logs = h.deps.callLogs.list("t");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.model_id).toBe(GEM);
  });

  it("resolves the model server-side from the registry by roles", async () => {
    h.deps.registry.upsert("t", entry(OSS, ["code_qa"], { code_qa: 90 }));
    const res = await h.callTool("run_sub_agent", { profile: "t", roles: ["code_qa"], brief: "What does this function do?" });
    expect(res.ok).toBe(true);
    const data = res.data as { model_id: string; role: string };
    expect(data.model_id).toBe(OSS);
    expect(data.role).toBe("code_qa");
  });

  it("no registry match returns a structured error, not a throw", async () => {
    const res = await h.callTool("run_sub_agent", { profile: "t", roles: ["poet"], brief: "Write a haiku" });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("no_model_for_role");
    expect(res.error!.retryable).toBe(false);
  });

  it("unknown profile returns profile_not_found", async () => {
    const res = await h.callTool("run_sub_agent", { profile: "nope", model_id: GEM, brief: "x" });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("profile_not_found");
  });

  it("empty brief is rejected at the schema layer", async () => {
    const raw = await h.callToolRaw("run_sub_agent", { profile: "t", model_id: GEM, brief: "" });
    expect(raw.isError).toBe(true);
  });
});
