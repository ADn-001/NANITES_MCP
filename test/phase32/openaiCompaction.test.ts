/**
 * Phase T gate — btw compaction over the /v1/chat/completions + ttl transport.
 * A dynamic profile with `inference.ttl_s > 0` skips the summarizer
 * acquire/teardown entirely: every map chunk + the reduce run over the openai
 * transport with the per-request ttl (keeping the JIT-loaded summarizer warm
 * across the burst, auto-evicting on drain), and each chat still synthesizes
 * native-shaped stats for the ledger.
 */
import { describe, expect, it } from "vitest";
import { compactSessionContext } from "../../src/workflows/contextCompactionOrchestrator.js";
import { SUM_MODEL, createBtwHarness, mkMessages, summarizerEntry } from "./helpers.js";

describe("Phase T gate — ttl_s compacts btw over /v1/chat/completions", () => {
  it("N map chunks + reduce over openai, zero loads/unloads, every body ttl-bearing", async () => {
    const h = await createBtwHarness({ ttl_s: 45, registry: [summarizerEntry()] });
    try {
      const r = await compactSessionContext(h.deps, "t", mkMessages("ttl", 5));
      expect(r.chunk_count).toBe(5);
      expect(r.chats_run).toBe(6); // 5 map + 1 reduce
      expect(r.model_id).toBe(SUM_MODEL);
      // No explicit load/unload: LM Studio JIT owns the lifecycle via ttl.
      expect(h.counts.loads).toBe(0);
      expect(h.counts.unloads).toBe(0);
      expect(h.counts.chats).toBe(0);
      expect(h.openAiChats()).toBe(6);
      expect(h.loaded.has(SUM_MODEL)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("every compaction chat carries ttl + the model key + synthesized stats in the ledger", async () => {
    const h = await createBtwHarness({ ttl_s: 30, registry: [summarizerEntry()] });
    try {
      const prior = h.deps.callLogs.list("t").length;
      const r = await compactSessionContext(h.deps, "t", mkMessages("ttl-ledger", 3));
      const rows = h.deps.callLogs.list("t").slice(prior);
      expect(rows.length).toBe(r.chats_run);
      expect(h.openAiChats()).toBe(4); // 3 map + 1 reduce
      // Every chat addressed the registry key with the profile ttl.
      const bodies = h.openAiBodies();
      expect(bodies.length).toBe(4);
      expect(bodies.every((b) => b.model === SUM_MODEL)).toBe(true);
      expect(bodies.every((b) => b.ttl === 30)).toBe(true);
      expect(bodies.every((b) => typeof b.max_tokens === "number")).toBe(true);
      // Synthesized stats flow into the ledger rows (tokens + ttft present).
      expect(rows.every((x) => x.tokens_in === 42 && x.tokens_out === 9)).toBe(true);
    } finally {
      await h.close();
    }
  });
});
