import { nowIso } from "./db.js";
export class RegistryStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Insert-or-replace. Synchronous, so concurrent callers serialize with
     * last-write-wins semantics — no torn writes possible. */
    upsert(profileName, entry) {
        const now = nowIso();
        // Build the conflict clause from the fields the caller actually supplied.
        //
        // Every one of the seven write sites passes a PARTIAL entry, and the
        // previous unconditional `col = excluded.col` meant a partial write reset
        // performance_score to 50, wiped scores/score_minima, cleared last_tested,
        // and re-tagged a CLOUD model as local — provider is not in the primary key,
        // so the cloud/local distinction the leaderboard depends on was destroyed
        // by a score write.
        //
        // COALESCE is not sufficient: performance_score is NOT NULL DEFAULT 50, so a
        // caller that omits it cannot pass NULL and the insert path would still
        // overwrite a real score with 50. Only a column list can express "leave this
        // one alone".
        const updates = [];
        const setIf = (column, supplied) => {
            if (supplied)
                updates.push(`${column} = excluded.${column}`);
        };
        setIf("provider", entry.provider !== undefined);
        setIf("roles", entry.roles !== undefined);
        setIf("scores", entry.scores !== undefined);
        setIf("score_minima", entry.score_minima !== undefined);
        setIf("best_params", entry.best_params !== undefined);
        setIf("last_tested", entry.last_tested !== undefined);
        setIf("performance_score", entry.performance_score !== undefined);
        setIf("avg_load_ms", entry.avg_load_ms !== undefined);
        setIf("avg_response_ms", entry.avg_response_ms !== undefined);
        setIf("reasoning_type", entry.reasoning_type !== undefined);
        updates.push("updated_at = excluded.updated_at");
        if (updates.length === 0)
            return; // nothing to change; still a no-op upsert
        this.db
            .prepare(`INSERT INTO model_registry (profile_name, model_id, provider, roles, scores, score_minima, best_params, last_tested, performance_score, avg_load_ms, avg_response_ms, reasoning_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_name, COALESCE(provider, 'local'), model_id) DO UPDATE SET ${updates.join(", ")}`)
            .run(profileName, entry.model_id, entry.provider ?? null, JSON.stringify(entry.roles ?? []), JSON.stringify(entry.scores ?? {}), JSON.stringify(entry.score_minima ?? {}), JSON.stringify(entry.best_params ?? {}), entry.last_tested ?? null, entry.performance_score ?? 50, entry.avg_load_ms ?? null, entry.avg_response_ms ?? null, entry.reasoning_type ?? "unknown", entry.created_at ?? now, now);
    }
    /**
     * `provider` narrows the lookup now that the same model id can exist on more
     * than one provider. Omitted, it means the local row (provider IS NULL), which
     * is what every existing caller wants — a caller that genuinely wants a cloud
     * row must say which provider, rather than receiving whichever row sorted
     * first. The COALESCE mirrors the table's uniqueness rule, so "no provider"
     * can only ever match the local row and never a cloud one.
     */
    get(profileName, modelId, provider) {
        const row = this.db
            .prepare(`SELECT * FROM model_registry
          WHERE profile_name = ? AND model_id = ? AND COALESCE(provider, 'local') = ?`)
            .get(profileName, modelId, provider ?? "local");
        return row ? this.rowToEntry(row) : null;
    }
    /**
     * Any provider's row for this id. Distinct from get() on purpose: get() means
     * "the local row" when no provider is given, which is right for the local
     * paths but silently wrong for a caller that genuinely wants whichever
     * provider row exists — a retest of a provider-tagged model, or a caller
     * holding only an id. Prefers the local row when several match so a local
     * model still reads as local.
     */
    getAny(profileName, modelId) {
        const local = this.get(profileName, modelId);
        if (local)
            return local;
        const row = this.db
            .prepare(`SELECT * FROM model_registry
          WHERE profile_name = ? AND model_id = ? AND provider IS NOT NULL
          ORDER BY provider LIMIT 1`)
            .get(profileName, modelId);
        return row ? this.rowToEntry(row) : null;
    }
    list(profileName) {
        const rows = this.db
            .prepare("SELECT * FROM model_registry WHERE profile_name = ? ORDER BY model_id")
            .all(profileName);
        return rows.map((r) => this.rowToEntry(r));
    }
    /** Local-only view (provider IS NULL). Local LM Studio selection (findBestModel
     * callers) must use this so a cloud registry row can never win a local pick
     * and then be handed to LM Studio as a load id. */
    listLocal(profileName) {
        const rows = this.db
            .prepare("SELECT * FROM model_registry WHERE profile_name = ? AND provider IS NULL ORDER BY model_id")
            .all(profileName);
        return rows.map((r) => this.rowToEntry(r));
    }
    remove(profileName, modelId) {
        const result = this.db.prepare("DELETE FROM model_registry WHERE profile_name = ? AND model_id = ?").run(profileName, modelId);
        return Number(result.changes) > 0;
    }
    rowToEntry(row) {
        return {
            model_id: row.model_id,
            provider: row.provider ?? null,
            roles: safeJsonParse(row.roles, []),
            scores: safeJsonParse(row.scores, {}),
            score_minima: safeJsonParse(row.score_minima, {}),
            best_params: safeJsonParse(row.best_params, {}),
            last_tested: row.last_tested,
            performance_score: row.performance_score ?? 50,
            avg_load_ms: row.avg_load_ms,
            avg_response_ms: row.avg_response_ms,
            reasoning_type: row.reasoning_type ?? "unknown",
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
}
export function safeJsonParse(raw, fallback) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
