/**
 * Param-search attempt log. Every candidate config tried during a test regimen
 * run is recorded with the score it produced — not just the winner — so the
 * search is auditable and the best params can be re-derived deterministically
 * at finalization time.
 */
import { safeJsonParse } from "./registryStore.js";
import { nowIso } from "./db.js";
export class ParamSearchStore {
    db;
    constructor(db) {
        this.db = db;
    }
    log(entry) {
        const result = this.db
            .prepare(`INSERT INTO param_search_attempts (profile_name, model_id, attempt, params, score, detail, unit_id, candidate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(entry.profile_name, entry.model_id, entry.attempt, JSON.stringify(entry.params), entry.score, entry.detail, entry.unit_id ?? null, entry.candidate ?? null, entry.created_at ?? nowIso());
        return Number(result.lastInsertRowid);
    }
    list(profileName, modelId) {
        const rows = this.db
            .prepare("SELECT * FROM param_search_attempts WHERE profile_name = ? AND model_id = ? ORDER BY attempt ASC")
            .all(profileName, modelId);
        return rows.map((r) => ({
            id: r.id,
            profile_name: r.profile_name,
            model_id: r.model_id,
            attempt: r.attempt,
            params: safeJsonParse(r.params, {}),
            score: r.score,
            detail: r.detail,
            unit_id: r.unit_id,
            candidate: r.candidate,
            created_at: r.created_at,
        }));
    }
    /** Next attempt number for (profile, model): max + 1, so judge-time logging
     * (E4) continues the regimen's numbering instead of colliding with it. */
    nextAttempt(profileName, modelId) {
        const row = this.db
            .prepare("SELECT COALESCE(MAX(attempt), 0) AS m FROM param_search_attempts WHERE profile_name = ? AND model_id = ?")
            .get(profileName, modelId);
        return Number(row.m) + 1;
    }
    deleteBefore(profileName, iso) {
        const result = this.db
            .prepare("DELETE FROM param_search_attempts WHERE profile_name = ? AND created_at < ?")
            .run(profileName, iso);
        return Number(result.changes);
    }
    deleteAll(profileName) {
        const result = this.db.prepare("DELETE FROM param_search_attempts WHERE profile_name = ?").run(profileName);
        return Number(result.changes);
    }
}
/** Highest-scoring attempt wins; a tie keeps the first (earliest) attempt. */
export function bestParamsFromAttempts(attempts) {
    if (attempts.length === 0)
        return {};
    let best = attempts[0];
    for (const a of attempts) {
        if (a.score > best.score)
            best = a;
    }
    return samplingParamsOnly(best.params);
}
/** The planner owns output-token/context/reasoning sizing (E6); a registry
 * entry's persisted `best_params` may carry only sampling knobs. */
const SAMPLING_KEYS = new Set(["temperature", "top_p", "top_k", "min_p", "repeat_penalty"]);
export function samplingParamsOnly(params) {
    const out = {};
    for (const key of SAMPLING_KEYS) {
        const value = params[key];
        if (typeof value === "number" && Number.isFinite(value))
            out[key] = value;
    }
    return out;
}
