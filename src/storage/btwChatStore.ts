/**
 * The visible `/nanites-btw` chat header (btw-spec-v2 §3). One row per profile —
 * the spec dropped session ids entirely, so every tool/endpoint scopes by
 * `profile_name` alone. The row is the throwaway surface: a new `start_btw_chat`
 * call replaces it wholesale (new created_at), while the compaction caches live
 * in `contextCacheStore` untouched.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";

/** Async-job lifecycle states the row passes through (§4.1/§6). */
export type BtwChatStatus = "compacting" | "ready" | "error";

export interface BtwChat {
  profile_name: string;
  status: BtwChatStatus;
  /** Async-job handle of the compaction that populated this chat, if any. */
  job_id: string | null;
  /** Pinned model for this chat's lifetime (context_qa resolution, §7). */
  model_id: string | null;
  /** The held LM Studio instance answering this chat's turns, if loaded. */
  instance_id: string | null;
  /** Drives idle-hold teardown (§7) — bumped on every turn. */
  last_activity_at: string;
  created_at: string;
}

interface BtwChatRow {
  profile_name: string;
  status: BtwChatStatus;
  job_id: string | null;
  model_id: string | null;
  instance_id: string | null;
  last_activity_at: string;
  created_at: string;
}

export class BtwChatStore {
  constructor(private readonly db: DatabaseSync) {}

  get(profileName: string): BtwChat | null {
    const row = this.db.prepare("SELECT * FROM btw_chat WHERE profile_name = ?").get(profileName) as BtwChatRow | undefined;
    return row ?? null;
  }

  /** Insert-or-replace the whole row. A fresh `/nanites-btw` call passes a new
   * created_at; the old chat is fully superseded (§3). */
  set(chat: BtwChat): void {
    this.db
      .prepare(
        `INSERT INTO btw_chat (profile_name, status, job_id, model_id, instance_id, last_activity_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_name) DO UPDATE SET
           status = excluded.status,
           job_id = excluded.job_id,
           model_id = excluded.model_id,
           instance_id = excluded.instance_id,
           last_activity_at = excluded.last_activity_at,
           created_at = excluded.created_at`,
      )
      .run(chat.profile_name, chat.status, chat.job_id, chat.model_id, chat.instance_id, chat.last_activity_at, chat.created_at);
  }

  /** Bump only the last-activity stamp (a turn happened, §7 idle window resets). */
  touch(profileName: string, at: string = nowIso()): void {
    this.db.prepare("UPDATE btw_chat SET last_activity_at = ? WHERE profile_name = ?").run(at, profileName);
  }

  remove(profileName: string): void {
    this.db.prepare("DELETE FROM btw_chat WHERE profile_name = ?").run(profileName);
  }

  deleteAll(profileName: string): number {
    const result = this.db.prepare("DELETE FROM btw_chat WHERE profile_name = ?").run(profileName);
    return Number(result.changes);
  }

  deleteBefore(profileName: string, iso: string): number {
    const result = this.db.prepare("DELETE FROM btw_chat WHERE profile_name = ? AND created_at < ?").run(profileName, iso);
    return Number(result.changes);
  }
}
