import { nowIso } from "./db.js";
export class ProviderStickyStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Get the sticky model for a provider, or null if none. */
    getSticky(profileName, provider) {
        const row = this.db.prepare(`SELECT model_id FROM provider_sticky_models WHERE profile_name=? AND provider=?`).get(profileName, provider);
        return row ? String(row.model_id) : null;
    }
    /** Set/update the sticky model for a provider. */
    setSticky(profileName, provider, modelId) {
        this.db.prepare(`
      INSERT INTO provider_sticky_models (profile_name, provider, model_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_name, provider) DO UPDATE SET model_id=excluded.model_id, updated_at=excluded.updated_at
    `).run(profileName, provider, modelId, nowIso());
    }
    /** Clear the sticky model for a provider. */
    clearSticky(profileName, provider) {
        this.db.prepare(`DELETE FROM provider_sticky_models WHERE profile_name=? AND provider=?`).run(profileName, provider);
    }
}
