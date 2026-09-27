import { nowIso } from "./db.js";
export class TestResultStore {
    db;
    constructor(db) {
        this.db = db;
    }
    insert(entry) {
        const now = nowIso();
        const result = this.db
            .prepare(`INSERT INTO test_results (profile_name, model_id, unit_id, provider, status, candidate, test_run, score, raw_output, orchestrator_notes, user_notes, user_approved, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(entry.profile_name, entry.model_id, entry.unit_id, entry.provider ?? null, entry.status ?? "pending", entry.candidate ?? "baseline", entry.test_run ?? 0, entry.score ?? null, entry.raw_output ?? null, entry.orchestrator_notes ?? null, entry.user_notes ?? null, entry.user_approved ? 1 : 0, now, now);
        return Number(result.lastInsertRowid);
    }
    list(profileName, modelId) {
        const rows = this.db
            .prepare("SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? ORDER BY id")
            .all(profileName, modelId);
        return rows.map((r) => this.rowToResult(r));
    }
    listPending(profileName, modelId) {
        return this.list(profileName, modelId).filter((r) => r.status === "pending");
    }
    /** Held variant runs: judged units' second candidate, invisible to
     * listPending/getPendingJudgments/finalize until promoted by a baseline
     * submission. */
    listStaged(profileName, modelId) {
        return this.list(profileName, modelId).filter((r) => r.status === "staged");
    }
    /** Record a judgment on the unit's live row. Targets the `pending` row (or a
     * previously `judged` row being revised to approved), never a `staged` hold
     * or an old terminal row — serial judging means at most one such row exists.
     * `user_approved: true` promotes to `approved`. */
    submitJudgment(profileName, modelId, unitId, judgment) {
        const status = judgment.user_approved ? "approved" : "judged";
        const result = this.db
            .prepare(`UPDATE test_results
         SET status = ?, score = ?, orchestrator_notes = ?, user_approved = ?, user_notes = ?, updated_at = ?
         WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status IN ('pending', 'judged')`)
            .run(status, judgment.score, judgment.orchestrator_notes, judgment.user_approved ? 1 : 0, judgment.user_notes ?? null, nowIso(), profileName, modelId, unitId);
        return Number(result.changes) > 0;
    }
    /** Promote a judged unit's held `staged` variant to `pending` so the next
     * judgment pass sees it (serial judging: baseline first, then variant). */
    promoteStaged(profileName, modelId, unitId) {
        const result = this.db
            .prepare(`UPDATE test_results
         SET status = 'pending', updated_at = ?
         WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status = 'staged'`)
            .run(nowIso(), profileName, modelId, unitId);
        return Number(result.changes) > 0;
    }
    /** Adopt a judged unit's live (pending/staged) rows into the current run
     * stamp. A regimen re-run while a unit is mid-judgment skips the re-run (no
     * stacking, no doubled model calls) but re-stamps the surviving rows so the
     * latest-test_run aggregation still sees them once judged. */
    stampRun(profileName, modelId, unitId, testRun) {
        const result = this.db
            .prepare(`UPDATE test_results
         SET test_run = ?, updated_at = ?
         WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status IN ('pending', 'staged')`)
            .run(testRun, nowIso(), profileName, modelId, unitId);
        return Number(result.changes);
    }
    /** The live row for judging: the `pending` row first, else the held
     * `staged` row, else the most recent terminal row (for read-back). */
    get(profileName, modelId, unitId) {
        const pending = this.db
            .prepare("SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status = 'pending'")
            .get(profileName, modelId, unitId);
        if (pending)
            return this.rowToResult(pending);
        const staged = this.db
            .prepare("SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status = 'staged'")
            .get(profileName, modelId, unitId);
        if (staged)
            return this.rowToResult(staged);
        const latest = this.db
            .prepare("SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? AND unit_id = ? ORDER BY id DESC LIMIT 1")
            .get(profileName, modelId, unitId);
        return latest ? this.rowToResult(latest) : null;
    }
    /**
     * Cross-profile share: copy a source profile's *approved*
     * results into a target profile that points at the same LM Studio instance.
     * Only `approved` rows travel — pending/staged/judged judgments belong to the
     * profile that ran them. A row already present in the target (same model,
     * unit, candidate, run stamp) is skipped, never overwritten. Nothing is
     * auto-finalized in the target's registry; the copy is evidence a later
     * regimen/finalize can aggregate without re-running the model.
     */
    copyApprovedResults(sourceProfile, targetProfile, modelId) {
        const where = modelId ? " AND model_id = ?" : "";
        const params = modelId ? [sourceProfile, modelId] : [sourceProfile];
        const rows = this.db
            .prepare(`SELECT * FROM test_results WHERE profile_name = ? AND status = 'approved'${where}`)
            .all(...params);
        const existsStmt = this.db.prepare(`SELECT 1 FROM test_results
       WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND candidate = ? AND test_run = ? AND status = 'approved'
       LIMIT 1`);
        const insertStmt = this.db.prepare(`INSERT INTO test_results (profile_name, model_id, unit_id, provider, status, candidate, test_run, score, raw_output, orchestrator_notes, user_notes, user_approved, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
        let copied = 0;
        let skipped = 0;
        this.db.exec("BEGIN");
        try {
            const now = nowIso();
            for (const row of rows) {
                const dup = existsStmt.get(targetProfile, row.model_id, row.unit_id, row.candidate, row.test_run) !== undefined;
                if (dup) {
                    skipped += 1;
                    continue;
                }
                insertStmt.run(targetProfile, row.model_id, row.unit_id, row.provider, row.candidate ?? "baseline", row.test_run, row.score, row.raw_output, row.orchestrator_notes, row.user_notes, now, now);
                copied += 1;
            }
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
        return { copied, skipped };
    }
    rowToResult(row) {
        return {
            id: row.id,
            profile_name: row.profile_name,
            model_id: row.model_id,
            unit_id: row.unit_id,
            provider: row.provider ?? null,
            status: row.status,
            candidate: row.candidate ?? "baseline",
            test_run: row.test_run,
            score: row.score,
            raw_output: row.raw_output,
            orchestrator_notes: row.orchestrator_notes,
            user_notes: row.user_notes,
            user_approved: row.user_approved === 1,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
}
