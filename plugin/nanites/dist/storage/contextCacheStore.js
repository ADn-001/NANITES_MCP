import { nowIso } from "./db.js";
function parseJson(raw, fallback) {
    if (!raw)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
export class ContextCacheStore {
    db;
    constructor(db) {
        this.db = db;
    }
    // ---- diff state (context_cache) ----
    getDiffState(profileName) {
        const row = this.db.prepare("SELECT * FROM context_cache WHERE profile_name = ?").get(profileName);
        if (!row)
            return null;
        return {
            message_hashes: parseJson(row.message_hashes, []),
            message_count: row.message_count,
            cached_through_index: row.cached_through_index,
            updated_at: row.updated_at,
        };
    }
    setDiffState(profileName, state, updated_at = nowIso()) {
        this.db
            .prepare(`INSERT INTO context_cache (profile_name, message_hashes, message_count, cached_through_index, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (profile_name) DO UPDATE SET
           message_hashes = excluded.message_hashes,
           message_count = excluded.message_count,
           cached_through_index = excluded.cached_through_index,
           updated_at = excluded.updated_at`)
            .run(profileName, JSON.stringify(state.message_hashes), state.message_count, state.cached_through_index, updated_at);
    }
    // ---- summary (context_summary_cache) ----
    getSummary(profileName) {
        const row = this.db
            .prepare("SELECT * FROM context_summary_cache WHERE profile_name = ?")
            .get(profileName);
        if (!row)
            return null;
        return {
            summary: row.summary,
            summary_tokens: row.summary_tokens,
            times_diffed_since_reduce: row.times_diffed_since_reduce,
            chunk_provenance: parseJson(row.chunk_provenance, null),
            updated_at: row.updated_at,
        };
    }
    setSummary(profileName, state, updated_at = nowIso()) {
        const existing = this.getSummary(profileName);
        this.db
            .prepare(`INSERT INTO context_summary_cache (profile_name, summary, summary_tokens, times_diffed_since_reduce, chunk_provenance, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_name) DO UPDATE SET
           summary = excluded.summary,
           summary_tokens = excluded.summary_tokens,
           times_diffed_since_reduce = excluded.times_diffed_since_reduce,
           chunk_provenance = excluded.chunk_provenance,
           updated_at = excluded.updated_at`)
            .run(profileName, state.summary, state.summary_tokens, state.times_diffed_since_reduce ?? existing?.times_diffed_since_reduce ?? 0, state.chunk_provenance !== undefined ? JSON.stringify(state.chunk_provenance) : existing?.chunk_provenance === null ? null : JSON.stringify(existing?.chunk_provenance ?? null), updated_at);
    }
    deleteAll(profileName) {
        let n = 0;
        n += Number(this.db.prepare("DELETE FROM context_cache WHERE profile_name = ?").run(profileName).changes);
        n += Number(this.db.prepare("DELETE FROM context_summary_cache WHERE profile_name = ?").run(profileName).changes);
        return n;
    }
    deleteBefore(profileName, iso) {
        let n = 0;
        n += Number(this.db.prepare("DELETE FROM context_cache WHERE profile_name = ? AND updated_at < ?").run(profileName, iso).changes);
        n += Number(this.db.prepare("DELETE FROM context_summary_cache WHERE profile_name = ? AND updated_at < ?").run(profileName, iso).changes);
        return n;
    }
}
