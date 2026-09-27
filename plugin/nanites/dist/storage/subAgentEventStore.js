import { nowIso } from "./db.js";
export class SubAgentEventStore {
    db;
    constructor(db) {
        this.db = db;
    }
    insert(event) {
        const result = this.db
            .prepare(`INSERT INTO sub_agent_events (profile_name, model_id, phase, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`)
            .run(event.profile_name, event.model_id, event.phase, JSON.stringify(event.payload ?? {}), event.created_at ?? nowIso());
        return Number(result.lastInsertRowid);
    }
    /** Events with id strictly greater than `afterId`, oldest first. */
    listSince(profileName, afterId, limit = 200) {
        const rows = this.db
            .prepare("SELECT * FROM sub_agent_events WHERE profile_name = ? AND id > ? ORDER BY id ASC LIMIT ?")
            .all(profileName, afterId, limit);
        return rows.map((r) => this.rowToEvent(r));
    }
    /** Events for a profile at or after an ISO instant, oldest first (recency replay). */
    listSinceByTime(profileName, sinceIso, limit = 200) {
        const rows = this.db
            .prepare("SELECT * FROM sub_agent_events WHERE profile_name = ? AND created_at >= ? ORDER BY id DESC LIMIT ?")
            .all(profileName, sinceIso, limit);
        // ORDER BY id DESC takes the NEWEST rows in the window. The array is
        // still returned oldest-first, which is what the docblock promises and
        // what the SSE replay consumes.
        return rows.reverse().map((r) => this.rowToEvent(r));
    }
    /** Highest event id for a profile (0 when none) — the poll resume floor. */
    maxId(profileName) {
        const row = this.db
            .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM sub_agent_events WHERE profile_name = ?")
            .get(profileName);
        return Number(row.m);
    }
    deleteBefore(profileName, iso) {
        const result = this.db
            .prepare("DELETE FROM sub_agent_events WHERE profile_name = ? AND created_at < ?")
            .run(profileName, iso);
        return Number(result.changes);
    }
    deleteAll(profileName) {
        const result = this.db.prepare("DELETE FROM sub_agent_events WHERE profile_name = ?").run(profileName);
        return Number(result.changes);
    }
    rowToEvent(r) {
        let payload = {};
        try {
            payload = JSON.parse(r.payload);
        }
        catch {
            payload = {};
        }
        return {
            id: r.id,
            profile_name: r.profile_name,
            model_id: r.model_id,
            phase: r.phase,
            payload,
            created_at: r.created_at,
        };
    }
}
