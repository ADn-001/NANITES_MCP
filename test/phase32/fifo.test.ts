/**
 * Phase 32 gate (Phase H) — job-mode FIFO coexistence (btw-spec-v2 §9). The
 * `btw_compact` job waits for a free profile slot like any other job-mode kind:
 * a queued btw chat must never stall or eject a running real sub-agent job. The
 * compaction runs only after the real job finishes, on the same profile's slot.
 */
import { describe, expect, it } from "vitest";
import { startSubAgentJob, getSubAgentJobStatus } from "../../src/workflows/jobRunner.js";
import { startBtwChat } from "../../src/workflows/startBtwChat.js";
import { sleep } from "../phase29/helpers.js";
import {
  createBtwHarness,
  mkMessages,
  qaEntry,
  summarizerEntry,
  REAL_MODEL,
  QA_MODEL,
  compactOut,
} from "./helpers.js";

describe("Phase 32 gate — btw_compact stays behind a running real job", () => {
  it("queues behind a running sub-agent job and compacts only after it finishes", async () => {
    const h = await createBtwHarness({ registry: [summarizerEntry(), qaEntry()], chatDelayMs: 600 });
    try {
      // A real job occupies the profile's single sequential slot for ~600ms.
      const realId = startSubAgentJob(h.deps, { profile: "t", brief: "Fix the accounting bug in ledger.ts", model_id: REAL_MODEL });
      await waitStatus(h, realId, "running");

      // Start a btw chat while the real job is mid-flight.
      const res = await startBtwChat(h.deps, { profile: "t", messages: mkMessages("fifo", 2), graceMs: 0 });
      const btwId = res.job_id;
      expect(getSubAgentJobStatus(h.deps, btwId).status).toBe("queued");

      // While the real job is still running the btw job must stay queued — it
      // neither preempts the real job nor starts alongside it on a full slot.
      const windowStart = Date.now();
      let realStayedRunning = true;
      while (Date.now() - windowStart < 350) {
        const btw = getSubAgentJobStatus(h.deps, btwId).status;
        const real = getSubAgentJobStatus(h.deps, realId).status;
        expect(btw).toBe("queued"); // btw never started before the real job finished
        if (real !== "running") {
          realStayedRunning = false; // real finished early — stop asserting (timing guard)
          break;
        }
        await sleep(25);
      }
      if (realStayedRunning) {
        // The running real job's instance is still resident — the queued btw job
        // did not eject it to grab the slot.
        expect(h.loaded.has(REAL_MODEL)).toBe(true);
      }

      // Real job finishes first, then the btw job drains on the freed slot.
      const realDone = await waitStatus(h, realId, "done");
      expect((realDone.result as { reply?: string }).reply).toBe("done");

      const btwJob = await h.waitJobDone(btwId, "deferred btw compact");
      const out = compactOut(btwJob.result as Record<string, unknown>);
      expect(out.status).toBe("cold");
      expect(out.chunk_count).toBe(2);

      // The btw chat reached a held ready state with its own QA model resident.
      const chat = h.deps.btwChat.get("t");
      expect(chat?.status).toBe("ready");
      expect(chat?.model_id).toBe(QA_MODEL);
      expect(h.loaded.has(QA_MODEL)).toBe(true);
      expect(h.loaded.has(REAL_MODEL)).toBe(false); // real job released its model
    } finally {
      await h.close();
    }
  });
});

async function waitStatus(
  h: Awaited<ReturnType<typeof createBtwHarness>>,
  jobId: number,
  status: "running" | "done",
): Promise<{ result?: unknown }> {
  const start = Date.now();
  for (;;) {
    const s = getSubAgentJobStatus(h.deps, jobId);
    if (s.status === status) return { result: s.result };
    if (s.status === "error") throw new Error(`job ${jobId} errored: ${JSON.stringify(s.result)}`);
    if (Date.now() - start >= 20_000) throw new Error(`timed out waiting for job ${jobId} ${status}`);
    await sleep(25);
  }
}
