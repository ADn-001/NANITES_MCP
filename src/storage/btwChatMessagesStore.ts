/**
 * The throwaway Q&A transcript a `/nanites-btw` chat shows and the user
 * continues (btw-spec-v2 §3). Hard-wiped and rebuilt on every fresh
 * `start_btw_chat`; per profile, turns are a dense `turn_index` sequence so the
 * dashboard reads the transcript in one ordered query.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";

export type BtwMessageRole = "user" | "assistant";

export interface BtwMessage {
  profile_name: string;
  turn_index: number;
  role: BtwMessageRole;
  content: string;
  created_at: string;
}

interface BtwMessageRow {
  profile_name: string;
  turn_index: number;
  role: BtwMessageRole;
  content: string;
  created_at: string;
}

export class BtwChatMessagesStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Ordered transcript (oldest turn first) for a profile. */
  list(profileName: string): BtwMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM btw_chat_messages WHERE profile_name = ? ORDER BY turn_index")
      .all(profileName) as unknown as BtwMessageRow[];
    return rows;
  }

  /** Wipe the transcript and write a fresh seed transcript (turn 0..n-1). */
  replace(profileName: string, messages: Array<{ role: BtwMessageRole; content: string; created_at?: string }>): void {
    this.db.prepare("DELETE FROM btw_chat_messages WHERE profile_name = ?").run(profileName);
    const insert = this.db.prepare(
      "INSERT INTO btw_chat_messages (profile_name, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [i, m] of messages.entries()) {
      insert.run(profileName, i, m.role, m.content, m.created_at ?? nowIso());
    }
  }

  /** Append one turn at the next free index; returns the stored row. */
  append(profileName: string, role: BtwMessageRole, content: string, created_at: string = nowIso()): BtwMessage {
    const row = this.db
      .prepare("SELECT MAX(turn_index) AS m FROM btw_chat_messages WHERE profile_name = ?")
      .get(profileName) as { m: number | null };
    const next = (row.m ?? -1) + 1;
    this.db
      .prepare("INSERT INTO btw_chat_messages (profile_name, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(profileName, next, role, content, created_at);
    return { profile_name: profileName, turn_index: next, role, content, created_at };
  }

  deleteAll(profileName: string): number {
    const result = this.db.prepare("DELETE FROM btw_chat_messages WHERE profile_name = ?").run(profileName);
    return Number(result.changes);
  }

  deleteBefore(profileName: string, iso: string): number {
    const result = this.db.prepare("DELETE FROM btw_chat_messages WHERE profile_name = ? AND created_at < ?").run(profileName, iso);
    return Number(result.changes);
  }
}
