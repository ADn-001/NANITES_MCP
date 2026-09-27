/**
 * Param-search attempt log. Every candidate config tried during a test regimen
 * run is recorded with the score it produced — not just the winner — so the
 * search is auditable and the best params can be re-derived deterministically
 * at finalization time.
 */
import { safeJsonParse } from "./registryStore.js";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";
import type { ChatRequestParams } from "../lmstudio/types.js";

export interface ParamSearchAttempt {
  id?: number;
  profile_name: string;
  model_id: string;
  attempt: number;
  params: ChatRequestParams;
  score: number;
  detail: string;
  /** Attribution only (nullable): the unit whose candidate produced this
   * attempt. Judged-unit attempts are logged at submit time, so deterministic
   * attempts carry unit/candidate and judged rows do too. */
  unit_id?: string | null;
  candidate?: string | null;
  created_at?: string;
}

interface ParamSearchRow {
  id: number;
  profile_name: string;
  model_id: string;
  attempt: number;
  params: string;
  score: number;
  detail: string;
  unit_id: string | null;
  candidate: string | null;
  created_at: string;
}

export class ParamSearchStore {
  constructor(private readonly db: DatabaseSync) {}

  log(entry: Omit<ParamSearchAttempt, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO param_search_attempts (profile_name, model_id, attempt, params, score, detail, unit_id, candidate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.profile_name,
        entry.model_id,
        entry.attempt,
        JSON.stringify(entry.params),
        entry.score,
        entry.detail,
        entry.unit_id ?? null,
        entry.candidate ?? null,
        entry.created_at ?? nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  list(profileName: string, modelId: string): ParamSearchAttempt[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM param_search_attempts WHERE profile_name = ? AND model_id = ? ORDER BY attempt ASC",
      )
      .all(profileName, modelId) as unknown as ParamSearchRow[];
    return rows.map((r) => ({
      id: r.id,
      profile_name: r.profile_name,
      model_id: r.model_id,
      attempt: r.attempt,
      params: safeJsonParse<ChatRequestParams>(r.params, {} as ChatRequestParams),
      score: r.score,
      detail: r.detail,
      unit_id: r.unit_id,
      candidate: r.candidate,
      created_at: r.created_at,
    }));
  }

  /** Next attempt number for (profile, model): max + 1, so judge-time logging
   * (E4) continues the regimen's numbering instead of colliding with it. */
  nextAttempt(profileName: string, modelId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(attempt), 0) AS m FROM param_search_attempts WHERE profile_name = ? AND model_id = ?")
      .get(profileName, modelId) as { m: number };
    return Number(row.m) + 1;
  }

  deleteBefore(profileName: string, iso: string): number {
    const result = this.db
      .prepare("DELETE FROM param_search_attempts WHERE profile_name = ? AND created_at < ?")
      .run(profileName, iso);
    return Number(result.changes);
  }

  deleteAll(profileName: string): number {
    const result = this.db.prepare("DELETE FROM param_search_attempts WHERE profile_name = ?").run(profileName);
    return Number(result.changes);
  }
}

/** Highest-scoring attempt wins; a tie keeps the first (earliest) attempt. */
export function bestParamsFromAttempts(attempts: ParamSearchAttempt[]): Record<string, unknown> {
  if (attempts.length === 0) return {};
  let best = attempts[0]!;
  for (const a of attempts) {
    if (a.score > best.score) best = a;
  }
  return samplingParamsOnly(best.params);
}

/** The planner owns output-token/context/reasoning sizing (E6); a registry
 * entry's persisted `best_params` may carry only sampling knobs. */
const SAMPLING_KEYS = new Set(["temperature", "top_p", "top_k", "min_p", "repeat_penalty"]);

export function samplingParamsOnly(params: ChatRequestParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAMPLING_KEYS) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
