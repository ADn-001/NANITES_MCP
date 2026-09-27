import { NanitesError } from "../helpers/errors.js";
import { nowIso } from "../storage/db.js";
import { validateTestUnit } from "./validator.js";
import { DEFAULT_REGIMEN } from "./defaultRegimen.js";
export class TestUnitRegistry {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Validate + persist. Throws a structured error listing every issue. */
    register(profileName, unit) {
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
        const validated = unit;
        this.db
            .prepare(`INSERT INTO test_units (profile_name, unit_id, unit, registered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (profile_name, unit_id) DO UPDATE SET
           unit = excluded.unit, registered_at = excluded.registered_at`)
            .run(profileName, validated.id, JSON.stringify(validated), nowIso());
        return validated;
    }
    /** Register the built-in default regimen wholesale. Idempotent: units that
     * already exist for the profile are left untouched (duplicate-id rejection
     * still applies to individual `register` calls). */
    registerDefaultRegimen(profileName) {
        const existing = new Set(this.list(profileName).map((u) => u.id));
        return DEFAULT_REGIMEN.filter((unit) => !existing.has(unit.id)).map((unit) => this.register(profileName, unit));
    }
    list(profileName) {
        const rows = this.db
            .prepare("SELECT * FROM test_units WHERE profile_name = ? ORDER BY unit_id")
            .all(profileName);
        return rows.map((r) => this.rowToUnit(r)).filter((u) => u !== null);
    }
    get(profileName, unitId) {
        const row = this.db
            .prepare("SELECT * FROM test_units WHERE profile_name = ? AND unit_id = ?")
            .get(profileName, unitId);
        return row ? this.rowToUnit(row) : null;
    }
    remove(profileName, unitId) {
        const result = this.db
            .prepare("DELETE FROM test_units WHERE profile_name = ? AND unit_id = ?")
            .run(profileName, unitId);
        return Number(result.changes) > 0;
    }
    rowToUnit(row) {
        try {
            return JSON.parse(row.unit);
        }
        catch {
            return null;
        }
    }
}
function formatIssues(issues) {
    return issues.map((i) => `${i.field}: ${i.message}`).join("; ");
}
