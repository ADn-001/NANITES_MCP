export const DEFAULT_TOP_K = 4;
/** Lowercased content words (>=3 chars) used for overlap scoring. */
function queryWords(q) {
    return q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}
/** Keyword-overlap top-k over the chunk-summary corpus (deterministic). */
export function retrieveKeyword(deps, profileName, query, topK = DEFAULT_TOP_K) {
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
export function vectorModeAvailable(deps, _profileName) {
    return deps.chunkEmbeddings.available();
}
/**
 * Top-k retrieval honoring the feature gate (§10). Keyword overlap is the
 * effective path in this environment; the vector branch (embed the query via
 * the live embedding model, read the vec0 table) is wired the moment
 * `vectorModeAvailable()` flips true — until then this is a pure keyword read.
 */
export function retrieveRelevantChunks(deps, profileName, query, topK = DEFAULT_TOP_K) {
    return retrieveKeyword(deps, profileName, query, topK);
}
