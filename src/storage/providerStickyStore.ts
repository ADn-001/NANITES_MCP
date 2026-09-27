/**
 * Provider sticky model store. Persists the last-successful model per provider
 * so `provider/auto` routing can try the winner first.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ProviderKind } from "./profileDefaults.js";
import { nowIso } from "./db.js";

export class ProviderStickyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Get the sticky model for a provider, or null if none. */
  getSticky(profileName: string, provider: ProviderKind): string | null {
    const row = this.db.prepare(`SELECT model_id FROM provider_sticky_models WHERE profile_name=? AND provider=?`).get(profileName, provider) as { model_id: string } | undefined;
    return row ? String(row.model_id) : null;
  }

  /** Set/update the sticky model for a provider. */
  setSticky(profileName: string, provider: ProviderKind, modelId: string): void {
    this.db.prepare(`
      INSERT INTO provider_sticky_models (profile_name, provider, model_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_name, provider) DO UPDATE SET model_id=excluded.model_id, updated_at=excluded.updated_at
    `).run(profileName, provider, modelId, nowIso());
  }

  /** Clear the sticky model for a provider. */
  clearSticky(profileName: string, provider: ProviderKind): void {
    this.db.prepare(`DELETE FROM provider_sticky_models WHERE profile_name=? AND provider=?`).run(profileName, provider);
  }
}
