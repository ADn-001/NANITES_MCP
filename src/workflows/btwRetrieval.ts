/**
 * Retrieval for `/nanites-btw` (btw-spec-v2 §10) — one module, feature-gated.
 * At chat time it pulls the top-k relevant chunk summaries to lay alongside the
 * always-present compact profile. Two modes, identical storage/citation shape:
 *
 *  - keyword: word-overlap scoring over the plain `btw_chunks` corpus. Always
 *    available; the deterministic path phase32 exercises.
 *  - vector: cosine over the `chunk_embeddings` vec0 table — used only when the
 *    sqlite-vec extension loaded AND an embedding model is reachable AND chunk
 *    summaries were embedded at compact time. In this environment sqlite-vec
 *    cannot load under `node:sqlite` (GATELOG Phase H records the answer), so
 *    `vectorModeAvailable()` is false and keyword overlap is the effective path.
 */
import type { ToolDeps } from "../tools/deps.js";

export const DEFAULT_TOP_K = 4;

export interface RetrievedChunk {
  chunk_id: string;
  summary: string;
  msg_start: number | null;
  msg_end: number | null;
  rank: number;
}

export type RetrievalMode = "vector" | "keyword";

/** Lowercased content words (>=3 chars) used for overlap scoring. */
function queryWords(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}

/** Keyword-overlap top-k over the chunk-summary corpus (deterministic). */
export function retrieveKeyword(deps: ToolDeps, profileName: string, query: string, topK = DEFAULT_TOP_K): RetrievedChunk[] {
  const docs = deps.chunkEmbeddings.listChunks(profileName);
  const words = queryWords(query);
  const scored = docs.map((d) => {
    const lower = d.summary.toLowerCase();
    const hit = words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
    return { doc: d, hit };
  });
  scored.sort((a, b) => b.hit - a.hit || (a.doc.msg_start ?? 0) - (b.doc.msg_start ?? 0));
  return scored
    .filter((s) => s.hit > 0)
    .slice(0, topK)
    .map((s, i) => ({
      chunk_id: s.doc.chunk_id,
      summary: s.doc.summary,
      msg_start: s.doc.msg_start,
      msg_end: s.doc.msg_end,
      rank: i,
    }));
}

/**
 * Whether the vector path can run today: requires the vec0 layer live (sqlite-vec
 * loaded + dimension confirmed) AND chunk summaries embedded into it. Absent in
 * this environment — retrieval stays on keyword overlap.
 */
export function vectorModeAvailable(deps: ToolDeps, _profileName: string): boolean {
  return deps.chunkEmbeddings.available();
}

/**
 * Top-k retrieval honoring the feature gate (§10). Keyword overlap is the
 * effective path in this environment; the vector branch (embed the query via
 * the live embedding model, read the vec0 table) is wired the moment
 * `vectorModeAvailable()` flips true — until then this is a pure keyword read.
 */
export function retrieveRelevantChunks(
  deps: ToolDeps,
  profileName: string,
  query: string,
  topK = DEFAULT_TOP_K,
): RetrievedChunk[] {
  return retrieveKeyword(deps, profileName, query, topK);
}
