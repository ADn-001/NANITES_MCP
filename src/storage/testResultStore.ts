/**
 * Test-unit results per (profile, model, unit). Supports the
 * orchestrator-judged flow with serial candidate judging (Phase E): a judged
 * unit runs its `baseline` candidate to `pending` and its `variant` candidate
 * to the internal `staged` status (output held). Submitting the pending
 * baseline promotes the staged sibling to `pending` for a second judgment.
 * Only `approved` (user-approved, or deterministically won) rows feed the
 * registry aggregation. `candidate` + `test_run` stamp every row so repeated
 * runs are distinguishable; pending rows are unique per (unit, candidate).
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";
import type { ProviderKind } from "./profileDefaults.js";

export type TestStatus = "pending" | "judged" | "approved" | "staged";

export type TestCandidate = "baseline" | "variant";

export interface TestResult {
  id?: number;
  profile_name: string;
  model_id: string;
  unit_id: string;
  status: TestStatus;
  /** Namespace the tested model lives in: NULL = local LM Studio key, else a
   * cloud provider kind. Stamped on cloud regimen inserts so finalize (reached
   * from the provider-less submit path) can tag the registry entry. */
  provider?: ProviderKind | null;
  /** Which param candidate produced this row ("baseline" recommended config,
   * "variant" deliberately sloppier). Deterministic rows record the winner. */
  candidate?: TestCandidate;
  /** Run stamp: rows inserted by the same regimen invocation share a run. */
  test_run?: number;
  score?: number | null;
  raw_output?: string | null;
  orchestrator_notes?: string | null;
  user_notes?: string | null;
  user_approved?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface TestResultRow {
  id: number;
  profile_name: string;
  model_id: string;
  unit_id: string;
  provider: string | null;
  status: string;
  candidate: string;
  test_run: number;
  score: number | null;
  raw_output: string | null;
  orchestrator_notes: string | null;
  user_notes: string | null;
  user_approved: number;
  created_at: string;
  updated_at: string;
}

export class TestResultStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(entry: TestResult): number {
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO test_results (profile_name, model_id, unit_id, provider, status, candidate, test_run, score, raw_output, orchestrator_notes, user_notes, user_approved, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.profile_name,
        entry.model_id,
        entry.unit_id,
        entry.provider ?? null,
        entry.status ?? "pending",
        entry.candidate ?? "baseline",
        entry.test_run ?? 0,
        entry.score ?? null,
        entry.raw_output ?? null,
        entry.orchestrator_notes ?? null,
        entry.user_notes ?? null,
        entry.user_approved ? 1 : 0,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  list(profileName: string, modelId: string): TestResult[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? ORDER BY id",
      )
      .all(profileName, modelId) as unknown as TestResultRow[];
    return rows.map((r) => this.rowToResult(r));
  }

  listPending(profileName: string, modelId: string): TestResult[] {
    return this.list(profileName, modelId).filter((r) => r.status === "pending");
  }

  /** Held variant runs: judged units' second candidate, invisible to
   * listPending/getPendingJudgments/finalize until promoted by a baseline
   * submission. */
  listStaged(profileName: string, modelId: string): TestResult[] {
    return this.list(profileName, modelId).filter((r) => r.status === "staged");
  }

  /** Record a judgment on the unit's live row. Targets the `pending` row (or a
   * previously `judged` row being revised to approved), never a `staged` hold
   * or an old terminal row — serial judging means at most one such row exists.
   * `user_approved: true` promotes to `approved`. */
  submitJudgment(
    profileName: string,
    modelId: string,
    unitId: string,
    judgment: {
      score: number;
      orchestrator_notes: string;
      user_approved: boolean;
      user_notes?: string | null;
    },
  ): boolean {
    const status: TestStatus = judgment.user_approved ? "approved" : "judged";
    const result = this.db
      .prepare(
        `UPDATE test_results
         SET status = ?, score = ?, orchestrator_notes = ?, user_approved = ?, user_notes = ?, updated_at = ?
         WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status IN ('pending', 'judged')`,
      )
      .run(
        status,
        judgment.score,
        judgment.orchestrator_notes,
        judgment.user_approved ? 1 : 0,
        judgment.user_notes ?? null,
        nowIso(),
        profileName,
        modelId,
        unitId,
      );
    return Number(result.changes) > 0;
  }

  /** Promote a judged unit's held `staged` variant to `pending` so the next
   * judgment pass sees it (serial judging: baseline first, then variant). */
  promoteStaged(profileName: string, modelId: string, unitId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE test_results
         SET status = 'pending', updated_at = ?
         WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status = 'staged'`,
      )
      .run(nowIso(), profileName, modelId, unitId);
    return Number(result.changes) > 0;
  }

  /** Adopt a judged unit's live (pending/staged) rows into the current run
   * stamp. A regimen re-run while a unit is mid-judgment skips the re-run (no
   * stacking, no doubled model calls) but re-stamps the surviving rows so the
   * latest-test_run aggregation still sees them once judged. */
  stampRun(profileName: string, modelId: string, unitId: string, testRun: number): number {
    const result = this.db
      .prepare(
        `UPDATE test_results
         SET test_run = ?, updated_at = ?
         WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status IN ('pending', 'staged')`,
      )
      .run(testRun, nowIso(), profileName, modelId, unitId);
    return Number(result.changes);
  }

  /** The live row for judging: the `pending` row first, else the held
   * `staged` row, else the most recent terminal row (for read-back). */
  get(profileName: string, modelId: string, unitId: string): TestResult | null {
    const pending = this.db
      .prepare(
        "SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status = 'pending'",
      )
      .get(profileName, modelId, unitId) as TestResultRow | undefined;
    if (pending) return this.rowToResult(pending);
    const staged = this.db
      .prepare(
        "SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND status = 'staged'",
      )
      .get(profileName, modelId, unitId) as TestResultRow | undefined;
    if (staged) return this.rowToResult(staged);
    const latest = this.db
      .prepare(
        "SELECT * FROM test_results WHERE profile_name = ? AND model_id = ? AND unit_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(profileName, modelId, unitId) as TestResultRow | undefined;
    return latest ? this.rowToResult(latest) : null;
  }

  /**
   * Cross-profile share: copy a source profile's *approved*
   * results into a target profile that points at the same LM Studio instance.
   * Only `approved` rows travel — pending/staged/judged judgments belong to the
   * profile that ran them. A row already present in the target (same model,
   * unit, candidate, run stamp) is skipped, never overwritten. Nothing is
   * auto-finalized in the target's registry; the copy is evidence a later
   * regimen/finalize can aggregate without re-running the model.
   */
  copyApprovedResults(sourceProfile: string, targetProfile: string, modelId?: string): { copied: number; skipped: number } {
    const where = modelId ? " AND model_id = ?" : "";
    const params: Array<string> = modelId ? [sourceProfile, modelId] : [sourceProfile];
    const rows = this.db
      .prepare(`SELECT * FROM test_results WHERE profile_name = ? AND status = 'approved'${where}`)
      .all(...params) as unknown as TestResultRow[];

    const existsStmt = this.db.prepare(
      `SELECT 1 FROM test_results
       WHERE profile_name = ? AND model_id = ? AND unit_id = ? AND candidate = ? AND test_run = ? AND status = 'approved'
       LIMIT 1`,
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO test_results (profile_name, model_id, unit_id, provider, status, candidate, test_run, score, raw_output, orchestrator_notes, user_notes, user_approved, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );

    let copied = 0;
    let skipped = 0;
    this.db.exec("BEGIN");
    try {
      const now = nowIso();
      for (const row of rows) {
        const dup = existsStmt.get(targetProfile, row.model_id, row.unit_id, row.candidate, row.test_run) !== undefined;
        if (dup) {
          skipped += 1;
          continue;
        }
        insertStmt.run(
          targetProfile,
          row.model_id,
          row.unit_id,
          row.provider,
          row.candidate ?? "baseline",
          row.test_run,
          row.score,
          row.raw_output,
          row.orchestrator_notes,
          row.user_notes,
          now,
          now,
        );
        copied += 1;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { copied, skipped };
  }

  private rowToResult(row: TestResultRow): TestResult {
    return {
      id: row.id,
      profile_name: row.profile_name,
      model_id: row.model_id,
      unit_id: row.unit_id,
      provider: (row.provider as ProviderKind | null) ?? null,
      status: row.status as TestStatus,
      candidate: (row.candidate as TestCandidate) ?? "baseline",
      test_run: row.test_run,
      score: row.score,
      raw_output: row.raw_output,
      orchestrator_notes: row.orchestrator_notes,
      user_notes: row.user_notes,
      user_approved: row.user_approved === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
