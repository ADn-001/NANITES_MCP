/**
 * Phase 29 gate (Phase C) — job lifecycle. `start_sub_agent_job` returns a
 * job id immediately; `get_sub_agent_job_status` walks queued → running → done
 * with a result shaped like `run_sub_agent`'s; an erroring job lands
 * status:"error" with a structured { code, message, retryable }. Driven on the
 * phase8 sub-agent harness (profile "t", sequential tier max 1) via the same
 * exported workflow functions the MCP tools wrap.
 */
import { describe, expect, it } from "vitest";
import { createSubAgentHarness } from "../phase8/helpers.js";
import { startSubAgentJob, getSubAgentJobStatus } from "../../src/workflows/jobRunner.js";
import { sleep, waitFor } from "./helpers.js";

const OSS = "openai/gpt-oss-20b";

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject");
}

describe("Phase 29 gate — sub-agent job lifecycle", () => {
  it("queues, runs, and reports done with a run_sub_agent-shaped result", async () => {
    const h = await createSubAgentHarness({ chatDelayMs: 250 });
    try {
      const started = Date.now();
      const jobId = startSubAgentJob(h.deps, { profile: "t", brief: "Review this file for bugs.", model_id: OSS });
      const enqueueElapsed = Date.now() - started;

      // start returns before the job has been claimed (no await before this).
      expect(getSubAgentJobStatus(h.deps, jobId).status).toBe("queued");
      // enqueue is non-blocking — returning well under the generation time.
      expect(enqueueElapsed).toBeLessThan(500);

      await waitFor(`job ${jobId} running`, () => {
        const s = getSubAgentJobStatus(h.deps, jobId);
        return s.status === "running" ? s : null;
      });
      const done = await waitFor(`job ${jobId} done`, () => {
        const s = getSubAgentJobStatus(h.deps, jobId);
        return s.status === "done" ? s : null;
      });

      expect(done.status).toBe("done");
      const result = done.result as Record<string, unknown>;
      // Shaped like run_sub_agent's response (additive, no keys dropped).
      expect(result.reply).toBe("done");
      expect(result.role).toBeDefined();
      expect(result.model_id).toBe(OSS);
      expect(result.instance_id).toBe(OSS);
      expect(result.loaded_this_call).toBe(true);
      expect(result.unloaded).toBe(true);
      expect(result.token_usage).toMatchObject({ inputTokens: expect.any(Number) });
      expect(result.validation).toMatchObject({ cleaned: expect.any(Boolean) });
      expect(typeof result.performance_score).toBe("number");
      expect(result.metrics).toMatchObject({ infer_ms: expect.any(Number) });
      expect(Array.isArray(result.tools_used)).toBe(true);

      // Ran through the real workflow: one load, one unload, one chat.
      expect(h.counts.loads).toBe(1);
      expect(h.counts.unloads).toBe(1);
      expect(h.counts.chats).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("an erroring job lands status:error with structured { code, message, retryable }", async () => {
    const h = await createSubAgentHarness({ chatFail: true });
    try {
      const jobId = startSubAgentJob(h.deps, { profile: "t", brief: "hi", model_id: OSS });
      const err = await waitFor(`job ${jobId} error`, () => {
        const s = getSubAgentJobStatus(h.deps, jobId);
        return s.status === "error" ? s : null;
      });
      const result = err.result as { code: string; message: string; retryable: boolean; details?: unknown };
      expect(result.code).toBe("http_server_error");
      expect(result.message).toMatch(/HTTP 500/i);
      expect(result.retryable).toBe(true);
      expect(result.details).toBeDefined();
      // The slot is released even on failure — a second job drains to its own
      // terminal state instead of sitting queued behind a stuck first job.
      const second = startSubAgentJob(h.deps, { profile: "t", brief: "hi", model_id: OSS });
      const secondErr = await waitFor(`job ${second} error`, () => {
        const s = getSubAgentJobStatus(h.deps, second);
        return s.status === "error" ? s : null;
      });
      expect(secondErr.status).toBe("error");
    } finally {
      await h.close();
    }
  });

  it("get_sub_agent_job_status on a missing id is a structured error", async () => {
    const h = await createSubAgentHarness();
    try {
      const err = await rejection(() => Promise.resolve(getSubAgentJobStatus(h.deps, 999_999)));
      expect(err.message).toMatch(/no job with id/i);
    } finally {
      await h.close();
    }
  });

  it("queued/running carry no result; done carries the run result", async () => {
    const h = await createSubAgentHarness({ chatDelayMs: 250 });
    try {
      const jobId = startSubAgentJob(h.deps, { profile: "t", brief: "hi", model_id: OSS });
      // queued (sync, before the drain microtask runs)
      expect(getSubAgentJobStatus(h.deps, jobId).result).toBeUndefined();
      const running = await waitFor(`job ${jobId} running`, () => {
        const s = getSubAgentJobStatus(h.deps, jobId);
        return s.status === "running" ? s : null;
      });
      expect(running.result).toBeUndefined();
      const done = await waitFor(`job ${jobId} done`, () => {
        const s = getSubAgentJobStatus(h.deps, jobId);
        return s.status === "done" ? s : null;
      });
      expect(done.result).toBeDefined();
    } finally {
      await h.close();
    }
  });
});
