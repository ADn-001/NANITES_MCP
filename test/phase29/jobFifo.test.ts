/**
 * Phase 29 gate (Phase C) — job-mode FIFO vs. blocking refusal. On a
 * sequential tier (max 1), extra queued jobs wait in enqueue order and complete
 * in that order instead of erroring concurrency_limit; the blocking
 * `run_sub_agent` path keeps its hard-refuse-at-capacity semantics.
 */
import { describe, expect, it } from "vitest";
import { createSubAgentHarness } from "../phase8/helpers.js";
import { startSubAgentJob, getSubAgentJobStatus } from "../../src/workflows/jobRunner.js";
import { SubAgentPool } from "../../src/workflows/subAgentPool.js";
import { waitFor } from "./helpers.js";

const OSS = "openai/gpt-oss-20b";

describe("Phase 29 gate — job FIFO at capacity", () => {
  it("queued jobs complete in enqueue order rather than erroring at capacity", async () => {
    const h = await createSubAgentHarness({ chatDelayMs: 250 });
    try {
      // First job takes the tier's only slot.
      const a = startSubAgentJob(h.deps, { profile: "t", brief: "first", model_id: OSS });
      await waitFor(`job ${a} running`, () => {
        const s = getSubAgentJobStatus(h.deps, a);
        return s.status === "running" ? s : null;
      });

      // Two more land while the slot is busy — they must queue, not refuse.
      const b = startSubAgentJob(h.deps, { profile: "t", brief: "second", model_id: OSS });
      const c = startSubAgentJob(h.deps, { profile: "t", brief: "third", model_id: OSS });
      expect(getSubAgentJobStatus(h.deps, b).status).toBe("queued");
      expect(getSubAgentJobStatus(h.deps, c).status).toBe("queued");

      // Completion order == enqueue order.
      const doneOrder: number[] = [];
      const seen = new Set<number>();
      await waitFor("all three jobs done in FIFO order", () => {
        for (const id of [a, b, c]) {
          const s = getSubAgentJobStatus(h.deps, id);
          if (s.status === "error") throw new Error(`job ${id} errored unexpectedly`);
          if (s.status === "done" && !seen.has(id)) {
            seen.add(id);
            doneOrder.push(id);
          }
        }
        return seen.size === 3 ? true : null;
      });
      expect(doneOrder).toEqual([a, b, c]);

      // Each job ran as its own load + unload + chat.
      expect(h.counts.loads).toBe(3);
      expect(h.counts.unloads).toBe(3);
      expect(h.counts.chats).toBe(3);
    } finally {
      await h.close();
    }
  });

  it("a blocking run_sub_agent at capacity still refuses concurrency_limit", async () => {
    const h = await createSubAgentHarness();
    try {
      const shared = new SubAgentPool(1);
      shared.tryAcquire(); // occupy the only slot
      await expect(h.runAgent({ model_id: OSS, pool: shared })).rejects.toMatchObject({
        code: "concurrency_limit",
      });
      // Nothing ran.
      expect(h.counts.chats).toBe(0);
      expect(h.counts.unloads).toBe(0);
    } finally {
      await h.close();
    }
  });
});
