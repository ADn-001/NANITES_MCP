import { nowIso } from "./db.js";
export class BtwChatStore {
    db;
    constructor(db) {
        this.db = db;
    }
    get(profileName) {
        const row = this.db.prepare("SELECT * FROM btw_chat WHERE profile_name = ?").get(profileName);
        return row ?? null;
    }
    /** Insert-or-replace the whole row. A fresh `/nanites-btw` call passes a new
     * created_at; the old chat is fully superseded (§3). */
    set(chat) {
        this.db
            .prepare(`INSERT INTO btw_chat (profile_name, status, job_id, model_id, instance_id, last_activity_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_name) DO UPDATE SET
           status = excluded.status,
           job_id = excluded.job_id,
           model_id = excluded.model_id,
           instance_id = excluded.instance_id,
           last_activity_at = excluded.last_activity_at,
           created_at = excluded.created_at`)
            .run(chat.profile_name, chat.status, chat.job_id, chat.model_id, chat.instance_id, chat.last_activity_at, chat.created_at);
    }
    /** Bump only the last-activity stamp (a turn happened, §7 idle window resets). */
    touch(profileName, at = nowIso()) {
        this.db.prepare("UPDATE btw_chat SET last_activity_at = ? WHERE profile_name = ?").run(at, profileName);
    }
    remove(profileName) {
        this.db.prepare("DELETE FROM btw_chat WHERE profile_name = ?").run(profileName);
    }
    deleteAll(profileName) {
        const result = this.db.prepare("DELETE FROM btw_chat WHERE profile_name = ?").run(profileName);
        return Number(result.changes);
    }
    deleteBefore(profileName, iso) {
        const result = this.db.prepare("DELETE FROM btw_chat WHERE profile_name = ? AND created_at < ?").run(profileName, iso);
        return Number(result.changes);
    }
}
