/**
 * Phase 32 gate (Phase H) — chat-state machine + compaction cache semantics
 * (btw-spec-v2 §2/§3/§4.1). One active chat per profile: `start_btw_chat`
 * replaces the `btw_chat` row and hard-wipes the visible transcript while the
 * compaction caches (`context_cache` diff state + `context_summary_cache`)
 * survive — divergence is detected against those caches, not the chat. Driven
 * against the real workflow functions the MCP tools wrap.
 */
import { describe, expect, it } from "vitest";
import { compactSessionContext } from "../../src/workflows/contextCompactionOrchestrator.js";
import { startBtwChat } from "../../src/workflows/startBtwChat.js";
import { createBtwHarness, mkMessages, compactOut, qaEntry, summarizerEntry, QA_MODEL } from "./helpers.js";

describe("Phase 32 gate — btw chat state + compaction caches", () => {
  it("a fresh start_btw_chat compacts cold and holds the QA model with an empty transcript", async () => {
    const h = await createBtwHarness({ registry: [summarizerEntry(), qaEntry()] });
    try {
      const started = Date.now();
      const res = await startBtwChat(h.deps, { profile: "t", messages: mkMessages("seed", 3), graceMs: 0 });
      expect(res.status).toBe("processing"); // grace 0 => returns immediately
      expect(res.job_id).toBeGreaterThan(0);
      expect(res.deep_link_url).toContain("#/vox-terminus?mode=btw&maximize=1");

      const job = await h.waitJobDone(res.job_id, "cold compact");
      const out = compactOut(job.result as Record<string, unknown>);
      expect(out.status).toBe("cold");
      expect(out.chunk_count).toBe(3); // each message its own chunk
      expect(out.chats_run).toBe(4); // 3 map + 1 reduce

      const chat = h.deps.btwChat.get("t");
      expect(chat?.status).toBe("ready");
      expect(chat?.model_id).toBe(QA_MODEL);
      expect(chat?.instance_id).toBe(QA_MODEL); // held resident on the mock
      expect(chat?.job_id).toBe(String(res.job_id));
      expect(h.deps.btwChatMessages.list("t")).toHaveLength(0); // no question => no turns
      expect(h.deps.contextCache.getSummary("t")).not.toBeNull();
      expect(h.loaded.has(QA_MODEL)).toBe(true);
      // Deep link is not authoritative on wall-clock for a 0-grace call, but the
      // whole flow (enqueue → drain → hold) completed in reasonable time.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await h.close();
    }
  });

  it("replacing the active chat wipes the transcript but keeps the compaction caches", async () => {
    const h = await createBtwHarness({ registry: [summarizerEntry(), qaEntry()] });
    try {
      const first = await startBtwChat(h.deps, { profile: "t", messages: mkMessages("reset", 3), graceMs: 0 });
      await h.waitJobDone(first.job_id, "first compact");
      const summaryBefore = h.deps.contextCache.getSummary("t");
      expect(summaryBefore?.summary.length).toBeGreaterThan(0);

      const second = await startBtwChat(h.deps, { profile: "t", messages: [], graceMs: 0 });
      const job2 = await h.waitJobDone(second.job_id, "second compact");
      const out2 = compactOut(job2.result as Record<string, unknown>);
      // Nothing new to diff; caches were not cleared by the reset, so this is a
      // pure cache read (hit_no_diff), not a fresh cold start.
      expect(out2.status).toBe("hit_no_diff");

      const chat = h.deps.btwChat.get("t");
      expect(chat?.status).toBe("ready");
      expect(chat?.model_id).toBe(QA_MODEL);
      expect(chat?.job_id).toBe(String(second.job_id));
      // Transcript replaced + empty; the compaction caches survived verbatim.
      expect(h.deps.btwChatMessages.list("t")).toHaveLength(0);
      const summaryAfter = h.deps.contextCache.getSummary("t");
      expect(summaryAfter?.summary).toBe(summaryBefore?.summary);
      expect(h.deps.contextCache.getDiffState("t")?.message_count).toBe(3);
    } finally {
      await h.close();
    }
  });

  it("diff statuses track the transcript against the cached diff state", async () => {
    const h = await createBtwHarness({ registry: [summarizerEntry()] });
    try {
      // 1) cold on a fresh profile
      let beforeLoads = h.counts.loads;
      const r1 = await compactSessionContext(h.deps, "t", mkMessages("A", 3));
      expect(r1.cache_status).toBe("cold");
      expect(r1.new_message_count).toBe(3);
      expect(r1.chunk_count).toBe(3);
      expect(r1.chats_run).toBe(4);
      expect(h.counts.loads - beforeLoads).toBe(1); // one summarizer load for map+reduce

      // 2) append-only tail diffs in (messages 0-2 already cached)
      beforeLoads = h.counts.loads;
      const r2 = await compactSessionContext(h.deps, "t", mkMessages("A", 5));
      expect(r2.cache_status).toBe("diffed");
      expect(r2.new_message_count).toBe(2);
      expect(r2.chunk_count).toBe(2);
      expect(r2.chats_run).toBe(3);
      expect(h.counts.loads - beforeLoads).toBe(1);
      expect(h.deps.contextCache.getSummary("t")?.times_diffed_since_reduce).toBe(0);

      // 3) a longer but unrelated transcript loses every prefix hash => full rebuild
      beforeLoads = h.counts.loads;
      const r3 = await compactSessionContext(h.deps, "t", mkMessages("B", 6));
      expect(r3.cache_status).toBe("invalidated_full_rebuild");
      expect(r3.new_message_count).toBe(6);
      expect(r3.chunk_count).toBe(6);
      expect(r3.chats_run).toBe(7);
      expect(h.counts.loads - beforeLoads).toBe(1);

      // 4) identical transcript => hit_no_diff, no model touched
      beforeLoads = h.counts.loads;
      const r4 = await compactSessionContext(h.deps, "t", mkMessages("B", 6));
      expect(r4.cache_status).toBe("hit_no_diff");
      expect(r4.new_message_count).toBe(0);
      expect(r4.chunk_count).toBe(0);
      expect(r4.chats_run).toBe(0);
      expect(h.counts.loads - beforeLoads).toBe(0);
      expect(h.deps.contextCache.getDiffState("t")?.message_count).toBe(6);
    } finally {
      await h.close();
    }
  });
});
