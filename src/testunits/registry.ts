/**
 * Per-profile test-unit registration. `register` ALWAYS validates in the same
 * call chain — it re-runs validateTestUnit against the current registered id
 * set before persisting. There is deliberately no public path that accepts a
 * "pre-validated" unit or a skip-validation flag, so a bypass is impossible.
 */
import type { DatabaseSync } from "node:sqlite";
import { NanitesError } from "../helpers/errors.js";
import { nowIso } from "../storage/db.js";
import { validateTestUnit, type ValidationIssue } from "./validator.js";
import type { TestUnit } from "./schema.js";
import { DEFAULT_REGIMEN } from "./defaultRegimen.js";

interface TestUnitRow {
  profile_name: string;
  unit_id: string;
  unit: string;
  registered_at: string;
}

export class TestUnitRegistry {
  constructor(private readonly db: DatabaseSync) {}

  /** Validate + persist. Throws a structured error listing every issue. */
  register(profileName: string, unit: unknown): TestUnit {
    const existingIds = this.list(profileName).map((u) => u.id);
    const { ok, issues } = validateTestUnit(unit, existingIds);
    if (!ok) {
      throw new NanitesError({
        code: "test_unit_invalid",
        message: formatIssues(issues),
        retryable: false,
        details: { issues },
      });
    }
    const validated = unit as TestUnit;
    this.db
      .prepare(
        `INSERT INTO test_units (profile_name, unit_id, unit, registered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (profile_name, unit_id) DO UPDATE SET
           unit = excluded.unit, registered_at = excluded.registered_at`,
      )
      .run(profileName, validated.id, JSON.stringify(validated), nowIso());
    return validated;
  }

  /** Register the built-in default regimen wholesale. Idempotent: units that
   * already exist for the profile are left untouched (duplicate-id rejection
   * still applies to individual `register` calls). */
  registerDefaultRegimen(profileName: string): TestUnit[] {
    const existing = new Set(this.list(profileName).map((u) => u.id));
    return DEFAULT_REGIMEN.filter((unit) => !existing.has(unit.id)).map((unit) => this.register(profileName, unit));
  }

  list(profileName: string): TestUnit[] {
    const rows = this.db
      .prepare("SELECT * FROM test_units WHERE profile_name = ? ORDER BY unit_id")
      .all(profileName) as unknown as TestUnitRow[];
    return rows.map((r) => this.rowToUnit(r)).filter((u): u is TestUnit => u !== null);
  }

  get(profileName: string, unitId: string): TestUnit | null {
    const row = this.db
      .prepare("SELECT * FROM test_units WHERE profile_name = ? AND unit_id = ?")
      .get(profileName, unitId) as TestUnitRow | undefined;
    return row ? this.rowToUnit(row) : null;
  }

  remove(profileName: string, unitId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM test_units WHERE profile_name = ? AND unit_id = ?")
      .run(profileName, unitId);
    return Number(result.changes) > 0;
  }

  private rowToUnit(row: TestUnitRow): TestUnit | null {
    try {
      return JSON.parse(row.unit) as TestUnit;
    } catch {
      return null;
    }
  }
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.field}: ${i.message}`).join("; ");
}
