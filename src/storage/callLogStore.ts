/**
 * Sub-agent call log: tokens in/out, duration, model, timestamp per call.
 * Used later by the cost-saved report and sub-agent workflow.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";

export interface CallLogEntry {
  id?: number;
  profile_name: string;
  model_id: string;
  task?: string | null;
  role?: string | null;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  cost_usd?: number | null;
  created_at?: string;
  ttft_ms?: number | null;
  load_ms?: number | null;
  error_code?: string | null;
  context_window?: number | null;
}

interface CallLogRow {
  id: number;
  profile_name: string;
  model_id: string;
  task: string | null;
  role: string | null;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  cost_usd: number | null;
  created_at: string;
  ttft_ms: number | null;
  load_ms: number | null;
  error_code: string | null;
  context_window: number | null;
}

export class CallLogStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(entry: CallLogEntry): number {
    const result = this.db
      .prepare(
        `INSERT INTO sub_agent_calls (profile_name, model_id, task, role, tokens_in, tokens_out, duration_ms, cost_usd, created_at, ttft_ms, load_ms, error_code, context_window)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.profile_name,
        entry.model_id,
        entry.task ?? null,
        entry.role ?? null,
        entry.tokens_in,
        entry.tokens_out,
        entry.duration_ms,
        entry.cost_usd ?? null,
        entry.created_at ?? nowIso(),
        entry.ttft_ms ?? null,
        entry.load_ms ?? null,
        entry.error_code ?? null,
        entry.context_window ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Newest-first call logs. `sinceIso` bounds the window in SQL — the ledger
   * used to pull a million rows and filter in JS, which is the same data with
   * the work in the wrong place.
   */
  list(profileName: string, limit = 100, sinceIso?: string | null): CallLogEntry[] {
    const rows = (sinceIso
      ? this.db
          .prepare(
            "SELECT * FROM sub_agent_calls WHERE profile_name = ? AND created_at >= ? ORDER BY id DESC LIMIT ?",
          )
          .all(profileName, sinceIso, limit)
      : this.db
          .prepare(
            "SELECT * FROM sub_agent_calls WHERE profile_name = ? ORDER BY id DESC LIMIT ?",
          )
          .all(profileName, limit)) as unknown as CallLogRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Last N runs for one model, newest first — feeds the performance scorer. */
  recentForModel(profileName: string, modelId: string, n: number): CallLogEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM sub_agent_calls WHERE profile_name = ? AND model_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(profileName, modelId, n) as unknown as CallLogRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  deleteBefore(profileName: string, iso: string): number {
    const result = this.db
      .prepare("DELETE FROM sub_agent_calls WHERE profile_name = ? AND created_at < ?")
      .run(profileName, iso);
    return Number(result.changes);
  }

  deleteAll(profileName: string): number {
    const result = this.db.prepare("DELETE FROM sub_agent_calls WHERE profile_name = ?").run(profileName);
    return Number(result.changes);
  }

  private rowToEntry(r: CallLogRow): CallLogEntry {
    return {
      id: r.id,
      profile_name: r.profile_name,
      model_id: r.model_id,
      task: r.task,
      role: r.role,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
      duration_ms: r.duration_ms,
      cost_usd: r.cost_usd,
      created_at: r.created_at,
      ttft_ms: r.ttft_ms,
      load_ms: r.load_ms,
      error_code: r.error_code,
      context_window: r.context_window,
    };
  }

  /** Aggregate tokens/cost for the cost report. */
  totals(profileName: string): { calls: number; tokens_in: number; tokens_out: number; cost_usd: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM sub_agent_calls WHERE profile_name = ?`,
      )
      .get(profileName) as { calls: number; tokens_in: number; tokens_out: number; cost_usd: number };
    return { calls: Number(row.calls), tokens_in: Number(row.tokens_in), tokens_out: Number(row.tokens_out), cost_usd: Number(row.cost_usd) };
  }
}
