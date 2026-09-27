import { nowIso } from "./db.js";
const SELECT_COLS = `id, profile_name, call_uid, provider, model_id, provider_request_id, task, role,
             tokens_in, tokens_out, duration_ms, finish_reason, cost_usd, ttft_ms, performance_score, status, created_at`;
export class ProviderCallLogStore {
    db;
    constructor(db) {
        this.db = db;
    }
    logCall(log) {
        const result = this.db.prepare(`
      INSERT INTO provider_sub_agent_calls
        (profile_name, call_uid, provider, model_id, provider_request_id, task, role,
         tokens_in, tokens_out, duration_ms, finish_reason, cost_usd, ttft_ms, performance_score, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(log.profile_name, log.call_uid, log.provider, log.model_id, log.provider_request_id ?? null, log.task ?? null, log.role ?? null, log.tokens_in, log.tokens_out, log.duration_ms, log.finish_reason ?? null, log.cost_usd ?? null, log.ttft_ms ?? null, log.performance_score ?? null, log.status, nowIso());
        return Number(result.lastInsertRowid);
    }
    /** Get recent call logs for scoring. Returns last N calls for a model. */
    getRecent(profileName, provider, modelId, limit = 20) {
        const rows = this.db.prepare(`
      SELECT ${SELECT_COLS}
      FROM provider_sub_agent_calls
      WHERE profile_name=? AND provider=? AND model_id=?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(profileName, provider, modelId, limit);
        return rows.map(rowToLog);
    }
    /**
     * Cloud calls for a profile, newest first, optionally bounded by a start
     * time. The ledger and the cost report read through this rather than pulling
     * every row and filtering in JS: written-but-never-read call logs were the
     * a known finding, and a range predicate belongs in the query.
     */
    listRecent(profileName, opts = {}) {
        const limit = opts.limit ?? 10_000;
        const rows = (opts.sinceIso
            ? this.db.prepare(`SELECT ${SELECT_COLS} FROM provider_sub_agent_calls
           WHERE profile_name=? AND created_at>=?
           ORDER BY created_at DESC LIMIT ?`).all(profileName, opts.sinceIso, limit)
            : this.db.prepare(`SELECT ${SELECT_COLS} FROM provider_sub_agent_calls
           WHERE profile_name=?
           ORDER BY created_at DESC LIMIT ?`).all(profileName, limit));
        return rows.map(rowToLog);
    }
}
/** Shared row mapping — `listRecent` and `getRecent` must agree on shape. */
function rowToLog(r) {
    return {
        id: Number(r.id),
        profile_name: String(r.profile_name),
        call_uid: String(r.call_uid),
        provider: String(r.provider),
        model_id: String(r.model_id),
        provider_request_id: r.provider_request_id ? String(r.provider_request_id) : null,
        task: r.task ? String(r.task) : null,
        role: r.role ? String(r.role) : null,
        tokens_in: Number(r.tokens_in),
        tokens_out: Number(r.tokens_out),
        duration_ms: Number(r.duration_ms),
        finish_reason: r.finish_reason != null ? String(r.finish_reason) : null,
        cost_usd: r.cost_usd != null ? Number(r.cost_usd) : null,
        ttft_ms: r.ttft_ms != null ? Number(r.ttft_ms) : null,
        performance_score: r.performance_score != null ? Number(r.performance_score) : null,
        status: String(r.status),
        created_at: String(r.created_at),
    };
}
