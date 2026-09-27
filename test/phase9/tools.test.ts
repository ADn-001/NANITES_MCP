/**
 * Phase 9 gate — Workflows #3/#4 tools over the MCP surface. download_and_wait,
 * download_and_test, diff_untested, run_untested_sweep, and filter_by_guardrail
 * exercised end to end through tools/call against the phase5 mock (which serves
 * a download that is immediately completed).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";

const GEM_SOURCE = "lmstudio-community/gemma-3-270m-it-qat"; // download source (HF repo id)
const GEM_KEY = "gemma-3-270m-it-qat"; // load/list identifier (model key)

describe("Phase 9 gate — workflow tools", () => {
  let h: ToolHarness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("download_and_wait polls to completed", async () => {
    const res = await h.callTool("download_and_wait", { profile: "t", source: GEM_SOURCE });
    expect(res.ok).toBe(true);
    const data = res.data as { status: string; polls: number; job_id: string };
    expect(data.status).toBe("completed");
    expect(data.polls).toBe(1);
    expect(data.job_id).toBe("job_493c7c9ded");
  });

  it("download_and_test chains Workflow #1 on completion", async () => {
    const res = await h.callTool("download_and_test", { profile: "t", source: GEM_SOURCE });
    expect(res.ok).toBe(true);
    const data = res.data as { download: { status: string }; regimen: { model_id: string } | null };
    expect(data.download.status).toBe("completed");
    expect(data.regimen).not.toBeNull();
    expect(data.regimen!.model_id).toBe(GEM_SOURCE);
  });

  it("diff_untested lists only unregistered LLM models", async () => {
    const res = await h.callTool("diff_untested", { profile: "t" });
    expect(res.ok).toBe(true);
    const data = res.data as { untested_count: number; models: Array<{ model: string }> };
    expect(data.untested_count).toBe(1);
    expect(data.models[0]!.model).toBe(GEM_KEY);
  });

  it("run_untested_sweep runs Workflow #1 for each untested model", async () => {
    const res = await h.callTool("run_untested_sweep", { profile: "t" });
    expect(res.ok).toBe(true);
    const data = res.data as { untested_count: number; models: string[]; summaries: unknown[] };
    expect(data.untested_count).toBe(1);
    expect(data.models).toEqual([GEM_KEY]);
    expect(data.summaries).toHaveLength(1);
  });

  it("filter_by_guardrail shortlists against the profile's tier", async () => {
    const res = await h.callTool("filter_by_guardrail", {
      profile: "t", // vram 4 -> baseline tier, <= ~8B
      candidates: [
        { model: "a/7b", params: "7B" },
        { model: "b/20b", params: "20B" },
        { model: "c/unknown" },
      ],
    });
    expect(res.ok).toBe(true);
    const data = res.data as { kept: Array<{ model: string }>; excluded: Array<{ model: string }> };
    expect(data.kept.map((c) => c.model).sort()).toEqual(["a/7b", "c/unknown"]);
    expect(data.excluded.map((c) => c.model)).toEqual(["b/20b"]);
  });

  it("empty candidate list is a schema error", async () => {
    const raw = await h.callToolRaw("filter_by_guardrail", { profile: "t", candidates: [] });
    expect(raw.isError).toBe(true);
  });
});
