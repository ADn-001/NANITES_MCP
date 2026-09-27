import { nowIso } from "./db.js";
import { NanitesError } from "../helpers/errors.js";
/** Provider values a pin may carry. */
export const PIN_PROVIDERS = [
    "local",
    "cloudflare",
    "openrouter",
    "omniroute",
    "generic",
];
export class RolePinStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Insert-or-replace the pin for a role. Rejects a provider outside the enum. */
    set(profileName, pin) {
        if (!PIN_PROVIDERS.includes(pin.provider)) {
            throw new NanitesError({
                code: "invalid_arguments",
                message: `Pin provider must be one of: ${PIN_PROVIDERS.join(", ")}. Got: ${pin.provider}`,
                retryable: false,
            });
        }
        const now = nowIso();
        this.db
            .prepare(`INSERT INTO role_pins (profile_name, role, provider, model_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (profile_name, role) DO UPDATE SET
           provider = excluded.provider,
           model_id = excluded.model_id,
           updated_at = excluded.updated_at,
           last_mismatch_at = NULL,
           last_mismatch_reason = NULL`)
            .run(profileName, pin.role, pin.provider, pin.model_id, pin.updated_at ?? now);
    }
    /**
     * Record that the capability gate rerouted a tool-bearing run away from this
     * pin. Best-effort: a pin that is gone by the time the gate
     * reports a mismatch writes nothing rather than resurrecting a deleted row.
     */
    markCapabilityMismatch(profileName, role, reason) {
        const result = this.db
            .prepare(`UPDATE role_pins SET last_mismatch_at = ?, last_mismatch_reason = ?
         WHERE profile_name = ? AND role = ?`)
            .run(nowIso(), reason, profileName, role);
        return Number(result.changes) > 0;
    }
    get(profileName, role) {
        const row = this.db
            .prepare("SELECT * FROM role_pins WHERE profile_name = ? AND role = ?")
            .get(profileName, role);
        return row ? this.rowToPin(row) : null;
    }
    list(profileName) {
        const rows = this.db
            .prepare("SELECT * FROM role_pins WHERE profile_name = ? ORDER BY role")
            .all(profileName);
        return rows.map((r) => this.rowToPin(r));
    }
    remove(profileName, role) {
        const result = this.db
            .prepare("DELETE FROM role_pins WHERE profile_name = ? AND role = ?")
            .run(profileName, role);
        return Number(result.changes) > 0;
    }
    rowToPin(row) {
        return {
            role: row.role,
            provider: row.provider,
            model_id: row.model_id,
            updated_at: row.updated_at,
            last_mismatch_at: row.last_mismatch_at ?? null,
            last_mismatch_reason: row.last_mismatch_reason ?? null,
        };
    }
}
