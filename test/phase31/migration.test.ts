/**
 * Phase 31 (E gate) — migration v11 up/down clean. A v10 DB (legacy rows, no
 * candidate/test_run/score_minima/attribution) upgrades in place: existing
 * pending rows read back with candidate='baseline'/test_run=0, score_minima
 * defaults to '{}', and param_search_attempts gain NULL unit_id/candidate. The
 * partial unique index makes pending rows idempotent per (unit, candidate) —
 * a second identical pending row is rejected while a same-unit staged (or
 * same-unit different-candidate) row coexists. A v10 DB polluted by the old D1
 * stacking bug (duplicate pending rows per unit) still upgrades: the migration
 * collapses each unit to its newest pending row before building the index.
 * Re-running applyMigrations is a clean no-op.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, applyMigrations } from "../../src/storage/migrations.js";

describe("migration v11 — registry scoring / regimen-state schema", () => {
  it("upgrades a v10 DB with legacy rows and enforces idempotent pending", () => {
    const db = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS) {
      if (m.version > 10) break;
      db.exec(m.sql);
    }
    db.exec("PRAGMA user_version = 10");

    // Legacy rows as they existed before v11 (D1 stacking was possible: two
    // pending rows for one unit had no candidate to disambiguate them — but a
    // clean DB has one per unit, which is what the migration index requires).
    db.prepare(
      `INSERT INTO test_results (profile_name, model_id, unit_id, status, score, raw_output, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    ).run("t", "m1", "task6-review-easy", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO model_registry (profile_name, model_id, roles, scores, best_params, last_tested, created_at, updated_at)
       VALUES (?, ?, '[]', '{}', '{}', NULL, ?, ?)`,
    ).run("t", "m1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO param_search_attempts (profile_name, model_id, attempt, params, score, detail, created_at)
       VALUES (?, ?, 1, '{}', 90, 'legacy', ?)`,
    ).run("t", "m1", "2026-01-01T00:00:00.000Z");

    applyMigrations(db);

    // New columns exist with sane defaults on the legacy rows.
    const legacy = db.prepare("SELECT * FROM test_results WHERE unit_id = 'task6-review-easy'").get() as Record<string, unknown>;
    expect(legacy.candidate).toBe("baseline");
    expect(legacy.test_run).toBe(0);
    const reg = db.prepare("SELECT score_minima FROM model_registry WHERE model_id = 'm1'").get() as Record<string, unknown>;
    expect(reg.score_minima).toBe("{}");
    const attempt = db.prepare("SELECT unit_id, candidate FROM param_search_attempts").get() as Record<string, unknown>;
    expect(attempt.unit_id).toBeNull();
    expect(attempt.candidate).toBeNull();

    // The partial unique index is present and scoped to pending rows.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'test_results'").all() as unknown as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("idx_test_results_pending");

    // A second pending row for the same (unit, candidate) is rejected — the
    // stacking bug this migration fixes cannot recur.
    const insertPending = (status: string, candidate: string, unitId: string): void => {
      db.prepare(
        `INSERT INTO test_results (profile_name, model_id, unit_id, status, candidate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("t", "m1", unitId, status, candidate, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    };
    expect(() => insertPending("pending", "baseline", "task6-review-easy")).toThrow();
    // Different candidate (the serial-judging variant) may pend alongside it.
    expect(() => insertPending("pending", "variant", "task6-review-easy")).not.toThrow();
    // Same-unit staged / approved rows are outside the index scope.
    expect(() => insertPending("staged", "baseline", "task6-review-easy")).not.toThrow();
    expect(() => insertPending("approved", "baseline", "task6-review-easy")).not.toThrow();

    // Re-running migrations is a clean no-op (idempotent up).
    expect(() => applyMigrations(db)).not.toThrow();
    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(ver.user_version)).toBe(MIGRATIONS.length);
    db.close();
  });

  it("upgrades a v10 DB polluted by the D1 stacking bug (duplicate pending rows per unit)", () => {
    const db = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS) {
      if (m.version > 10) break;
      db.exec(m.sql);
    }
    db.exec("PRAGMA user_version = 10");

    // The pre-v11 regimen stacked pending rows on re-run: two pending rows for
    // the same (profile, model, unit), no candidate to disambiguate them.
    const insertPending = (unitId: string, ts: string): void => {
      db.prepare(
        `INSERT INTO test_results (profile_name, model_id, unit_id, status, score, raw_output, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', NULL, 'raw', ?, ?)`,
      ).run("t", "m1", unitId, ts, ts);
    };
    insertPending("task6-review-easy", "2026-01-01T00:00:00.000Z");
    insertPending("task6-review-easy", "2026-02-01T00:00:00.000Z"); // newest

    // The migration must not fail on the duplicates — it collapses them first.
    expect(() => applyMigrations(db)).not.toThrow();

    // Exactly one pending survivor remains, and it is the newest row.
    const pending = db
      .prepare("SELECT id, updated_at, candidate, test_run FROM test_results WHERE status = 'pending'")
      .all() as unknown as Array<{ id: number; updated_at: string; candidate: string; test_run: number }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.updated_at).toBe("2026-02-01T00:00:00.000Z");
    expect(pending[0]!.candidate).toBe("baseline");
    expect(pending[0]!.test_run).toBe(0);

    // The dedupe touched only pending rows — a judged row for the same unit
    // survives untouched, and the index now enforces one pending per candidate.
    const judged = db
      .prepare("SELECT COUNT(*) AS n FROM test_results WHERE unit_id = 'task6-review-easy' AND status = 'judged'")
      .get() as { n: number };
    expect(Number(judged.n)).toBe(0);
    expect(() =>
      db
        .prepare(
          `INSERT INTO test_results (profile_name, model_id, unit_id, status, candidate, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 'baseline', ?, ?)`,
        )
        .run("t", "m1", "task6-review-easy", "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
    ).toThrow();

    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(ver.user_version)).toBe(MIGRATIONS.length);
    db.close();
  });
});
