/**
 * Jobs table — the generalized async-job queue behind Phase C. One SQLite table
 * shared by every long-horizon workflow kind (sub_agent now; regimen/sweep/btw
 * compaction later), replacing each operation's bespoke "start it, block, hope
 * the timeout is big enough" pattern. The queue IS the DB: status transitions
 * are guarded single-row updates, so claiming is race-safe across processes on
 * the same NANITES_HOME.
 */
import { safeJsonParse } from "./registryStore.js";
import { nowIso } from "./db.js";
import { NanitesError } from "../helpers/errors.js";
function toRecord(row) {
    return {
        id: row.id,
        profile_name: row.profile_name,
        kind: row.kind,
        status: row.status,
        payload: safeJsonParse(row.payload ?? "", {}),
        result: row.result ? safeJsonParse(row.result, null) : null,
        error_code: row.error_code,
        error_message: row.error_message,
        created_at: row.created_at,
        updated_at: row.updated_at,
        owner_id: row.owner_id ?? null,
        heartbeat_at: row.heartbeat_at ?? null,
    };
}
export class JobStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Insert a queued job; returns its id (the FIFO order key). */
    create(input) {
        const created = input.created_at ?? nowIso();
        const result = this.db
            .prepare(`INSERT INTO jobs (profile_name, kind, status, payload, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?)`)
            .run(input.profile_name, input.kind, JSON.stringify(input.payload), created, created);
        return Number(result.lastInsertRowid);
    }
    get(jobId) {
        const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
        return row ? toRecord(row) : null;
    }
    /** Oldest queued jobs first (FIFO by created_at, then id). */
    listQueued(limit = 64) {
        const rows = this.db
            .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT ?")
            .all(limit);
        return rows.map(toRecord);
    }
    /** Running jobs, newest first. Used by the boot sweep to find orphans. */
    listRunning() {
        const rows = this.db
            .prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at, id")
            .all();
        return rows.map(toRecord);
    }
    /**
     * Guarded queued→running transition; false if someone else claimed it first.
     * Also stamps the claiming process and its first heartbeat, which is what
     * lets a later process tell a live run from a dead one (migration 22).
     */
    markRunning(jobId, ownerId) {
        const now = nowIso();
        const result = this.db
            .prepare(`UPDATE jobs SET status = 'running', owner_id = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`)
            .run(ownerId, now, now, jobId);
        return Number(result.changes) > 0;
    }
    /** Refresh the liveness stamp for this owner's in-flight jobs. Returns rows touched. */
    touchRunning(ownerId) {
        const result = this.db
            .prepare("UPDATE jobs SET heartbeat_at = ? WHERE status = 'running' AND owner_id = ?")
            .run(nowIso(), ownerId);
        return Number(result.changes);
    }
    /**
     * Fail `running` jobs whose owner stopped heartbeating before `staleBeforeIso`.
     * A row with a *fresh* heartbeat is left alone even if the owner id differs —
     * several stdio MCP processes share one DB, and one process's boot must never
     * clobber another session's live run.
     */
    reclaimStaleRunning(staleBeforeIso, ownerId) {
        const now = nowIso();
        const reason = {
            code: "job_orphaned",
            message: "Job was interrupted by a process exit and the queue never resumed it",
            retryable: false,
        };
        const result = this.db
            .prepare(`UPDATE jobs SET status = 'error', result = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE status = 'running'
           AND (owner_id IS NULL OR owner_id != ?)
           AND (heartbeat_at IS NULL OR heartbeat_at < ?)`)
            .run(JSON.stringify(reason), reason.code, reason.message, now, ownerId, staleBeforeIso);
        return Number(result.changes);
    }
    /** Fail `queued` jobs older than the cutoff — a previous session's stale briefs. */
    expireStaleQueued(cutoffIso) {
        const now = nowIso();
        const reason = {
            code: "job_expired",
            message: "Queued job expired before it was ever started",
            retryable: true,
        };
        const result = this.db
            .prepare(`UPDATE jobs SET status = 'error', result = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE status = 'queued' AND created_at < ?`)
            .run(JSON.stringify(reason), reason.code, reason.message, now, cutoffIso);
        return Number(result.changes);
    }
    markDone(jobId, result) {
        this.db
            .prepare("UPDATE jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(result ?? null), nowIso(), jobId);
    }
    markError(jobId, error) {
        this.db
            .prepare(`UPDATE jobs SET status = 'error', result = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ?`)
            .run(JSON.stringify(error), error.code, error.message, nowIso(), jobId);
    }
    deleteAll(profileName) {
        const result = this.db.prepare("DELETE FROM jobs WHERE profile_name = ?").run(profileName);
        return Number(result.changes);
    }
    deleteBefore(profileName, iso) {
        const result = this.db.prepare("DELETE FROM jobs WHERE profile_name = ? AND created_at < ?").run(profileName, iso);
        return Number(result.changes);
    }
}
/** Structured error for a job id that no longer exists. */
export function jobNotFoundError(jobId) {
    return new NanitesError({ code: "job_not_found", message: `No job with id ${jobId}`, retryable: false });
}
