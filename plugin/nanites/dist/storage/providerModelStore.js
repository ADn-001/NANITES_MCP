/**
 * Provider model store. Manages cached model lists per provider, auto-discovery,
 * registration, and ordering.
 */
import { safeJsonParse } from "./registryStore.js";
/** A corrupt capabilities cell must degrade, not throw: this is read on the
 * model-list path. */
const EMPTY_CAPABILITIES = {
    vision: false,
    audio: false,
    video: false,
    function_calling: false,
};
import { nowIso } from "./db.js";
export class ProviderModelStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Upsert a batch of models from auto-discovery. Overwrites owned_by/context_window on re-discovery. */
    upsertModels(profileName, provider, models) {
        const stmt = this.db.prepare(`
      INSERT INTO provider_models
        (profile_name, provider, model_id, name, owned_by, context_window, max_output_tokens,
         pricing_prompt, pricing_completion, capabilities, supported_modalities, is_registered, last_refreshed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(profile_name, provider, model_id) DO UPDATE SET
        name=excluded.name, owned_by=excluded.owned_by, context_window=excluded.context_window,
        max_output_tokens=excluded.max_output_tokens, last_refreshed=excluded.last_refreshed, updated_at=excluded.updated_at,
        pricing_prompt=COALESCE(excluded.pricing_prompt, provider_models.pricing_prompt),
        pricing_completion=COALESCE(excluded.pricing_completion, provider_models.pricing_completion)
    `);
        const now = nowIso();
        for (const m of models) {
            const caps = m.capabilities ?? {};
            const modalities = [
                ...(caps.vision ? ["image"] : []),
                ...(caps.audio ? ["audio"] : []),
                ...(caps.video ? ["video"] : []),
                "text",
            ];
            stmt.run(profileName, provider, m.id, m.name ?? m.id, m.owned_by ?? null, m.context_length ?? null, null, 
            // COALESCE on update, so a discovery that publishes no price keeps the
            // manifest-seeded rate instead of erasing it.
            m.pricing_prompt ?? null, m.pricing_completion ?? null, JSON.stringify({ vision: caps.vision ?? false, audio: caps.audio ?? false, video: caps.video ?? false, function_calling: caps.function_calling ?? false }), JSON.stringify(modalities), now, now, now);
        }
    }
    /** Register a specific model with is_registered=1. */
    registerModel(profileName, provider, modelId, name, ownedBy, nickname) {
        const now = nowIso();
        this.db.prepare(`
      INSERT INTO provider_models
        (profile_name, provider, model_id, name, owned_by, context_window, max_output_tokens,
         pricing_prompt, pricing_completion, capabilities, supported_modalities, is_registered, nickname, last_refreshed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '{"vision":false,"audio":false,"video":false,"function_calling":false}', '["text"]', 1, ?, ?, ?, ?)
      ON CONFLICT(profile_name, provider, model_id) DO UPDATE SET
        is_registered=1, nickname=COALESCE(excluded.nickname, nickname), updated_at=excluded.updated_at
    `).run(profileName, provider, modelId, name ?? modelId, ownedBy ?? null, nickname ?? null, now, now, now);
    }
    /** Seed-register a model whose capabilities come from the manifest
     * rather than the discover API — CF discovery returns no capability data,
     * so `registerModel`'s vision:false default would mislabel the vision-capable
     * seeds. Idempotent upsert: re-seeding refreshes capabilities/modalities, keeps
     * nickname, and leaves is_registered=1. */
    registerManifestModel(profileName, provider, spec) {
        const now = nowIso();
        this.db
            .prepare(`
        INSERT INTO provider_models
          (profile_name, provider, model_id, name, owned_by, context_window, max_output_tokens,
           pricing_prompt, pricing_completion, capabilities, supported_modalities, is_registered, nickname, last_refreshed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
        ON CONFLICT(profile_name, provider, model_id) DO UPDATE SET
          name=excluded.name, owned_by=excluded.owned_by, context_window=excluded.context_window,
          pricing_prompt=excluded.pricing_prompt, pricing_completion=excluded.pricing_completion,
          capabilities=excluded.capabilities, supported_modalities=excluded.supported_modalities,
          is_registered=1, updated_at=excluded.updated_at
      `)
            .run(profileName, provider, spec.model_id, spec.name ?? spec.model_id, spec.owned_by ?? null, spec.context_length, spec.pricing_prompt ?? null, spec.pricing_completion ?? null, JSON.stringify({
            vision: spec.vision,
            audio: false,
            video: false,
            function_calling: spec.function_calling,
            reasoning: spec.reasoning ?? false,
        }), JSON.stringify([...(spec.vision ? ["image"] : []), "text"]), now, now, now);
    }
    /** Remove a model from the registry. */
    deregisterModel(profileName, provider, modelId) {
        this.db.prepare(`DELETE FROM provider_models WHERE profile_name=? AND provider=? AND model_id=?`).run(profileName, provider, modelId);
    }
    /** List models for a provider. registeredOnly=true returns only is_registered=1. */
    listModels(profileName, provider, registeredOnly = false) {
        const providerFilter = provider ? "AND provider=?" : "";
        const params = provider ? [profileName, provider] : [profileName];
        const rows = this.db.prepare(`
      SELECT profile_name, provider, model_id, name, nickname, owned_by, context_window, max_output_tokens,
             pricing_prompt, pricing_completion, capabilities, supported_modalities,
             is_registered, performance_score, last_refreshed, created_at, updated_at
      FROM provider_models
      WHERE profile_name=? ${providerFilter}
      ${registeredOnly ? "AND is_registered=1" : ""}
      ORDER BY name
    `).all(...params);
        return rows.map((r) => ({
            profile_name: String(r.profile_name),
            provider: String(r.provider),
            model_id: String(r.model_id),
            name: String(r.name),
            nickname: r.nickname ? String(r.nickname) : null,
            owned_by: r.owned_by ? String(r.owned_by) : null,
            context_window: r.context_window != null ? Number(r.context_window) : null,
            max_output_tokens: r.max_output_tokens != null ? Number(r.max_output_tokens) : null,
            pricing_prompt: r.pricing_prompt != null ? Number(r.pricing_prompt) : null,
            pricing_completion: r.pricing_completion != null ? Number(r.pricing_completion) : null,
            capabilities: safeJsonParse(String(r.capabilities), EMPTY_CAPABILITIES),
            supported_modalities: safeJsonParse(String(r.supported_modalities), []),
            is_registered: Boolean(r.is_registered),
            performance_score: r.performance_score != null ? Number(r.performance_score) : null,
            last_refreshed: r.last_refreshed ? String(r.last_refreshed) : null,
            created_at: String(r.created_at),
            updated_at: String(r.updated_at),
        }));
    }
    /** Get a single model. */
    getModel(profileName, provider, modelId) {
        const row = this.db.prepare(`
      SELECT profile_name, provider, model_id, name, nickname, owned_by, context_window, max_output_tokens,
             pricing_prompt, pricing_completion, capabilities, supported_modalities,
             is_registered, performance_score, last_refreshed, created_at, updated_at
      FROM provider_models
      WHERE profile_name=? AND provider=? AND model_id=?
    `).get(profileName, provider, modelId);
        if (!row)
            return null;
        return {
            profile_name: String(row.profile_name),
            provider: String(row.provider),
            model_id: String(row.model_id),
            name: String(row.name),
            nickname: row.nickname ? String(row.nickname) : null,
            owned_by: row.owned_by ? String(row.owned_by) : null,
            context_window: row.context_window != null ? Number(row.context_window) : null,
            max_output_tokens: row.max_output_tokens != null ? Number(row.max_output_tokens) : null,
            pricing_prompt: row.pricing_prompt != null ? Number(row.pricing_prompt) : null,
            pricing_completion: row.pricing_completion != null ? Number(row.pricing_completion) : null,
            capabilities: safeJsonParse(String(row.capabilities), EMPTY_CAPABILITIES),
            supported_modalities: safeJsonParse(String(row.supported_modalities), []),
            is_registered: Boolean(row.is_registered),
            performance_score: row.performance_score != null ? Number(row.performance_score) : null,
            last_refreshed: row.last_refreshed ? String(row.last_refreshed) : null,
            created_at: String(row.created_at),
            updated_at: String(row.updated_at),
        };
    }
    /** Update nickname for a model. */
    setNickname(profileName, provider, modelId, nickname) {
        this.db.prepare(`UPDATE provider_models SET nickname=? WHERE profile_name=? AND provider=? AND model_id=?`).run(nickname, profileName, provider, modelId);
    }
}
