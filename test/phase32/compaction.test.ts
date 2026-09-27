/**
 * Phase 32 gate (Phase H) — compaction resource/ledger discipline (btw-spec-v2
 * §6). Map+reduce must run through ONE load (never N load/unload cycles for N
 * chunks), every model chat writes a `sub_agent_calls` row (cost-saved still
 * sees each chunk), and the chunk-summary corpus is replaced per diff.
 */
import { describe, expect, it } from "vitest";
import { compactSessionContext } from "../../src/workflows/contextCompactionOrchestrator.js";
import { SUMMARIZER_ROLE, SUM_MODEL, createBtwHarness, mkMessages, summarizerEntry } from "./helpers.js";

describe("Phase 32 gate — compaction load-once + ledger + corpus", () => {
  it("summarizes N chunks through a single loaded model and unloads once", async () => {
    const h = await createBtwHarness({ registry: [summarizerEntry()] });
    try {
      const before = { loads: h.counts.loads, unloads: h.counts.unloads };
      const r = await compactSessionContext(h.deps, "t", mkMessages("ledger", 5));
      expect(r.chunk_count).toBe(5);
      expect(r.chats_run).toBe(6); // 5 map + 1 reduce
      // One model, one load, one unload — never a per-chunk load/unload loop.
      expect(h.counts.loads - before.loads).toBe(1);
      expect(h.counts.unloads - before.unloads).toBe(1);
      expect(r.model_id).toBe(SUM_MODEL);
      // The summarizer was not left resident (it is not the held QA instance).
      expect(h.loaded.has(SUM_MODEL)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("writes one ledger row per model chat (map chunks + reduce) with the summarizer role", async () => {
    const h = await createBtwHarness({ registry: [summarizerEntry()] });
    try {
      const prior = h.deps.callLogs.list("t").length;
      const r = await compactSessionContext(h.deps, "t", mkMessages("ledger", 4));
      const rows = h.deps.callLogs.list("t");
      expect(rows.length - prior).toBe(r.chats_run);
      const btw = rows.slice(0, rows.length - prior).filter((x) => x.role === SUMMARIZER_ROLE);
      expect(btw.length).toBe(r.chats_run);
      const tasks = btw.map((x) => x.task ?? "");
      expect(tasks.filter((t) => t.startsWith("btw map "))).toHaveLength(4);
      expect(tasks.filter((t) => t === "btw reduce")).toHaveLength(1);
      expect(btw.every((x) => x.model_id === SUM_MODEL)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("replaces the retrievable chunk corpus per diff with c{msg_start} chunk ids", async () => {
    const h = await createBtwHarness({ registry: [summarizerEntry()] });
    try {
      await compactSessionContext(h.deps, "t", mkMessages("corpus", 3));
      const docs = h.deps.chunkEmbeddings.listChunks("t");
      expect(docs).toHaveLength(3);
      expect(docs.map((d) => d.chunk_id)).toEqual(["c0", "c1", "c2"]);
      expect(docs.map((d) => d.msg_start)).toEqual([0, 1, 2]);
      expect(docs.map((d) => d.msg_end)).toEqual([0, 1, 2]);
      expect(docs.every((d) => d.summary.length > 0)).toBe(true);
      // Provenance mirrors the corpus exactly.
      const prov = h.deps.contextCache.getSummary("t")?.chunk_provenance ?? [];
      expect(prov.map((p) => p.chunk_id)).toEqual(["c0", "c1", "c2"]);
    } finally {
      await h.close();
    }
  });
});
