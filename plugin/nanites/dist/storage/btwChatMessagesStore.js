import { nowIso } from "./db.js";
export class BtwChatMessagesStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Ordered transcript (oldest turn first) for a profile. */
    list(profileName) {
        const rows = this.db
            .prepare("SELECT * FROM btw_chat_messages WHERE profile_name = ? ORDER BY turn_index")
            .all(profileName);
        return rows;
    }
    /** Wipe the transcript and write a fresh seed transcript (turn 0..n-1). */
    replace(profileName, messages) {
        this.db.prepare("DELETE FROM btw_chat_messages WHERE profile_name = ?").run(profileName);
        const insert = this.db.prepare("INSERT INTO btw_chat_messages (profile_name, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)");
        for (const [i, m] of messages.entries()) {
            insert.run(profileName, i, m.role, m.content, m.created_at ?? nowIso());
        }
    }
    /** Append one turn at the next free index; returns the stored row. */
    append(profileName, role, content, created_at = nowIso()) {
        const row = this.db
            .prepare("SELECT MAX(turn_index) AS m FROM btw_chat_messages WHERE profile_name = ?")
            .get(profileName);
        const next = (row.m ?? -1) + 1;
        this.db
            .prepare("INSERT INTO btw_chat_messages (profile_name, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(profileName, next, role, content, created_at);
        return { profile_name: profileName, turn_index: next, role, content, created_at };
    }
    deleteAll(profileName) {
        const result = this.db.prepare("DELETE FROM btw_chat_messages WHERE profile_name = ?").run(profileName);
        return Number(result.changes);
    }
    deleteBefore(profileName, iso) {
        const result = this.db.prepare("DELETE FROM btw_chat_messages WHERE profile_name = ? AND created_at < ?").run(profileName, iso);
        return Number(result.changes);
    }
}
