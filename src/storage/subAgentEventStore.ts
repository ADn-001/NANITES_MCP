/**
 * Sub-agent lifecycle event log. `runSubAgent` writes coarse phase events
 * (chat.start / model_load.end / chat.end); the companion UI's `/api/stream`
 * polls this table and fans out batched events to SSE clients. A DB table is
 * used instead of an in-process EventEmitter because the UI server runs as a
 * separate process sharing NANITES_HOME — an in-memory emitter cannot span
 * two processes.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";

export interface SubAgentEvent {
  id?: number;
  profile_name: string;
  model_id: string;
  phase: string;
  payload: Record<string, unknown>;
  created_at?: string;
}

interface SubAgentEventRow {
  id: number;
  profile_name: string;
  model_id: string;
  phase: string;
  payload: string;
  created_at: string;
}

export class SubAgentEventStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(event: SubAgentEvent): number {
    const result = this.db
      .prepare(
        `INSERT INTO sub_agent_events (profile_name, model_id, phase, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.profile_name,
        event.model_id,
        event.phase,
        JSON.stringify(event.payload ?? {}),
        event.created_at ?? nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  /** Events with id strictly greater than `afterId`, oldest first. */
  listSince(profileName: string, afterId: number, limit = 200): SubAgentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM sub_agent_events WHERE profile_name = ? AND id > ? ORDER BY id ASC LIMIT ?",
      )
      .all(profileName, afterId, limit) as unknown as SubAgentEventRow[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /** Events for a profile at or after an ISO instant, oldest first (recency replay). */
  listSinceByTime(profileName: string, sinceIso: string, limit = 200): SubAgentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM sub_agent_events WHERE profile_name = ? AND created_at >= ? ORDER BY id DESC LIMIT ?",
      )
      .all(profileName, sinceIso, limit) as unknown as SubAgentEventRow[];
    // ORDER BY id DESC takes the NEWEST rows in the window. The array is
    // still returned oldest-first, which is what the docblock promises and
    // what the SSE replay consumes.
    return rows.reverse().map((r) => this.rowToEvent(r));
  }

  /** Highest event id for a profile (0 when none) — the poll resume floor. */
  maxId(profileName: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM sub_agent_events WHERE profile_name = ?")
      .get(profileName) as { m: number };
    return Number(row.m);
  }

  deleteBefore(profileName: string, iso: string): number {
    const result = this.db
      .prepare("DELETE FROM sub_agent_events WHERE profile_name = ? AND created_at < ?")
      .run(profileName, iso);
    return Number(result.changes);
  }

  deleteAll(profileName: string): number {
    const result = this.db.prepare("DELETE FROM sub_agent_events WHERE profile_name = ?").run(profileName);
    return Number(result.changes);
  }

  private rowToEvent(r: SubAgentEventRow): SubAgentEvent {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
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
