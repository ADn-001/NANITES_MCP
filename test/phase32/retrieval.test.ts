/**
 * Phase 32 gate (Phase H) — retrieval (btw-spec-v2 §10) + the documented
 * environmental skip. Keyword-overlap is the deterministic path this suite
 * exercises; the vector branch is present but gated on sqlite-vec loading under
 * `node:sqlite`, which it cannot in this environment (GATELOG Phase H records
 * the answer) — `init` must report false and retrieval must still answer from
 * keyword overlap, never throw or hang on the missing extension.
 */
import { describe, expect, it } from "vitest";
import { retrieveRelevantChunks, vectorModeAvailable } from "../../src/workflows/btwRetrieval.js";
import { createBtwHarness } from "./helpers.js";

describe("Phase 32 gate — chunk retrieval (keyword path)", () => {
  it("ranks chunks by word overlap with the query", async () => {
    const h = await createBtwHarness();
    try {
      h.deps.chunkEmbeddings.replaceChunks("t", [
        { chunk_id: "c0", summary: "turboencabulator idle drift wattage measured at 7", msg_start: 0, msg_end: 3 },
        { chunk_id: "c1", summary: "grommet colors for the status LEDs", msg_start: 4, msg_end: 7 },
        { chunk_id: "c2", summary: "wattage budget across both turboencabulator banks", msg_start: 8, msg_end: 11 },
      ]);

      const hits = retrieveRelevantChunks(h.deps, "t", "turboencabulator wattage", 4);
      // Both c0 and c2 mention both words; the msg_start tie-break orders c0 first.
      expect(hits.map((x) => x.chunk_id)).toEqual(["c0", "c2"]);
      expect(hits[0]?.rank).toBe(0);
      expect(hits[1]?.rank).toBe(1);
      expect(hits.every((x) => x.summary.length > 0)).toBe(true);

      // No overlap => empty (never a fabricated hit).
      expect(retrieveRelevantChunks(h.deps, "t", "zebra linguistics")).toEqual([]);
      // Shorter query words (>=3) filter noise.
      const single = retrieveRelevantChunks(h.deps, "t", "idle drift", 4);
      expect(single.map((x) => x.chunk_id)).toEqual(["c0"]);
    } finally {
      await h.close();
    }
  });

  it("the vector layer is absent here and keyword retrieval stays the effective path", async () => {
    const h = await createBtwHarness();
    try {
      expect(h.deps.chunkEmbeddings.available()).toBe(false);
      expect(vectorModeAvailable(h.deps, "t")).toBe(false);
      // Extension load fails cleanly (documented skip) — never throws.
      await expect(h.deps.chunkEmbeddings.init(384)).resolves.toBe(false);
      expect(h.deps.chunkEmbeddings.available()).toBe(false);
      // Keyword path still answers over the plain corpus.
      h.deps.chunkEmbeddings.replaceChunks("t", [{ chunk_id: "c0", summary: "nanites scheduling policy", msg_start: 0, msg_end: 1 }]);
      expect(retrieveRelevantChunks(h.deps, "t", "scheduling", 2)[0]?.chunk_id).toBe("c0");
    } finally {
      await h.close();
    }
  });
});
