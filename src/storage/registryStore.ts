/**
 * Model-registry store: per-profile model entries with roles, scores,
 * best params, and last-tested timestamp. JSON-typed columns are
 * serialized on write and parsed on read.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";
import type { ReasoningType } from "../helpers/inferencePlanner.js";

export interface RegistryEntry {
  model_id: string;
  /** Namespace this entry lives in. null = local LM Studio key; else a cloud
   * provider kind ("cloudflare" | "openrouter" | "omniroute" | "generic").
   * Cloud rows share the roles/scores machinery with local ones. */
  provider?: string | null;
  roles: string[];
  /** Role-keyed aggregate fitness: `scores[role]` = mean of the role's approved
   * winner-unit scores from the latest test_run (produced by finalize/backfill,
   * never unit-id keys). roleMatch reads exactly this. */
  scores: Record<string, number>;
  /** Role-keyed worst approved winner-unit score per role (role -> min); feeds
   * the low-confidence floor (a role below FITNESS_FLOOR is weakly evidenced).
   * Absent on legacy/hand entries that never ran finalize/backfill. */
  score_minima?: Record<string, number>;
  best_params: Record<string, unknown>;
  last_tested: string | null;
  /** Algorithmic stability/speed score (1-100), recomputed after each run. */
  performance_score?: number;
  /** Rolling N=20 average wall-clock load time (ms) — sizes the next load timeout. */
  avg_load_ms?: number | null;
  /** Rolling N=20 average generation time (ms), excluding load. */
  avg_response_ms?: number | null;
  /** Learned reasoning capability: seeded from name heuristic, refined by run
   * evidence (reasoning_output_tokens > 0 => "reasoning"; a 400 on
   * reasoning:"on" => "non_reasoning"). "unknown" before any signal. */
  reasoning_type?: ReasoningType;
  created_at?: string;
  updated_at?: string;
}

interface RegistryRow {
  model_id: string;
  provider: string | null;
  roles: string;
  scores: string;
  score_minima: string;
  best_params: string;
  last_tested: string | null;
  performance_score: number | null;
  avg_load_ms: number | null;
  avg_response_ms: number | null;
  reasoning_type: string | null;
  created_at: string;
  updated_at: string;
}

export class RegistryStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert-or-replace. Synchronous, so concurrent callers serialize with
   * last-write-wins semantics — no torn writes possible. */
  upsert(profileName: string, entry: RegistryEntry): void {
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
    const updates: string[] = [];
    const setIf = (column: string, supplied: boolean): void => {
      if (supplied) updates.push(`${column} = excluded.${column}`);
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
    if (updates.length === 0) return; // nothing to change; still a no-op upsert

    this.db
      .prepare(
        `INSERT INTO model_registry (profile_name, model_id, provider, roles, scores, score_minima, best_params, last_tested, performance_score, avg_load_ms, avg_response_ms, reasoning_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_name, model_id) DO UPDATE SET ${updates.join(", ")}`,
      )
      .run(
        profileName,
        entry.model_id,
        entry.provider ?? null,
        JSON.stringify(entry.roles ?? []),
        JSON.stringify(entry.scores ?? {}),
        JSON.stringify(entry.score_minima ?? {}),
        JSON.stringify(entry.best_params ?? {}),
        entry.last_tested ?? null,
        entry.performance_score ?? 50,
        entry.avg_load_ms ?? null,
        entry.avg_response_ms ?? null,
        entry.reasoning_type ?? "unknown",
        entry.created_at ?? now,
        now,
      );
  }

  get(profileName: string, modelId: string): RegistryEntry | null {
    const row = this.db
      .prepare("SELECT * FROM model_registry WHERE profile_name = ? AND model_id = ?")
      .get(profileName, modelId) as RegistryRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  list(profileName: string): RegistryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM model_registry WHERE profile_name = ? ORDER BY model_id")
      .all(profileName) as unknown as RegistryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Local-only view (provider IS NULL). Local LM Studio selection (findBestModel
   * callers) must use this so a cloud registry row can never win a local pick
   * and then be handed to LM Studio as a load id. */
  listLocal(profileName: string): RegistryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM model_registry WHERE profile_name = ? AND provider IS NULL ORDER BY model_id")
      .all(profileName) as unknown as RegistryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  remove(profileName: string, modelId: string): boolean {
    const result = this.db.prepare("DELETE FROM model_registry WHERE profile_name = ? AND model_id = ?").run(profileName, modelId);
    return Number(result.changes) > 0;
  }

  private rowToEntry(row: RegistryRow): RegistryEntry {
    return {
      model_id: row.model_id,
      provider: row.provider ?? null,
      roles: safeJsonParse<string[]>(row.roles, []),
      scores: safeJsonParse<Record<string, number>>(row.scores, {}),
      score_minima: safeJsonParse<Record<string, number>>(row.score_minima, {}),
      best_params: safeJsonParse<Record<string, unknown>>(row.best_params, {}),
      last_tested: row.last_tested,
      performance_score: row.performance_score ?? 50,
      avg_load_ms: row.avg_load_ms,
      avg_response_ms: row.avg_response_ms,
      reasoning_type: (row.reasoning_type as ReasoningType | null) ?? "unknown",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
