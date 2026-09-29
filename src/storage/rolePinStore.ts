/**
 * Role-pin store. A pin is the preferred model for an
 * open-ended role: `{provider, model_id}` where provider `local` = LM Studio
 * registry key and cloud kinds use their provider model_id. One pin per role
 * per profile; absent pin = fall back to dynamic selection.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";
import { NanitesError } from "../helpers/errors.js";

export interface RolePin {
  role: string;
  /** "local" or a cloud provider kind. */
  provider: string;
  model_id: string;
  updated_at?: string;
  /** When the capability gate last rerouted a tool-bearing run away from this
   * pin. Historical, not current state — whether the pin is
   * rerouted *now* is recomputed from live capabilities on read. Absent on the
   * write path; always present on a read. */
  last_mismatch_at?: string | null;
  /** Why it was rerouted, in the gate's words. */
  last_mismatch_reason?: string | null;
}

/** Provider values a pin may carry. */
export const PIN_PROVIDERS: readonly string[] = [
  "local",
  "cloudflare",
  "openrouter",
  "omniroute",
  "generic",
  "nvidia",
];

interface RolePinRow {
  profile_name: string;
  role: string;
  provider: string;
  model_id: string;
  updated_at: string;
  last_mismatch_at: string | null;
  last_mismatch_reason: string | null;
}

export class RolePinStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert-or-replace the pin for a role. Rejects a provider outside the enum. */
  set(profileName: string, pin: RolePin): void {
    if (!PIN_PROVIDERS.includes(pin.provider)) {
      throw new NanitesError({
        code: "invalid_arguments",
        message: `Pin provider must be one of: ${PIN_PROVIDERS.join(", ")}. Got: ${pin.provider}`,
        retryable: false,
      });
    }
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO role_pins (profile_name, role, provider, model_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (profile_name, role) DO UPDATE SET
           provider = excluded.provider,
           model_id = excluded.model_id,
           updated_at = excluded.updated_at,
           last_mismatch_at = NULL,
           last_mismatch_reason = NULL`,
      )
      .run(profileName, pin.role, pin.provider, pin.model_id, pin.updated_at ?? now);
  }

  /**
   * Record that the capability gate rerouted a tool-bearing run away from this
   * pin. Best-effort: a pin that is gone by the time the gate
   * reports a mismatch writes nothing rather than resurrecting a deleted row.
   */
  markCapabilityMismatch(profileName: string, role: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE role_pins SET last_mismatch_at = ?, last_mismatch_reason = ?
         WHERE profile_name = ? AND role = ?`,
      )
      .run(nowIso(), reason, profileName, role);
    return Number(result.changes) > 0;
  }

  get(profileName: string, role: string): RolePin | null {
    const row = this.db
      .prepare("SELECT * FROM role_pins WHERE profile_name = ? AND role = ?")
      .get(profileName, role) as RolePinRow | undefined;
    return row ? this.rowToPin(row) : null;
  }

  list(profileName: string): RolePin[] {
    const rows = this.db
      .prepare("SELECT * FROM role_pins WHERE profile_name = ? ORDER BY role")
      .all(profileName) as unknown as RolePinRow[];
    return rows.map((r) => this.rowToPin(r));
  }

  remove(profileName: string, role: string): boolean {
    const result = this.db
      .prepare("DELETE FROM role_pins WHERE profile_name = ? AND role = ?")
      .run(profileName, role);
    return Number(result.changes) > 0;
  }

  private rowToPin(row: RolePinRow): RolePin {
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
