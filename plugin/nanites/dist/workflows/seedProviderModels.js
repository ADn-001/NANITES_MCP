/**
 * Bulk-seed + preferred-model pin workflows. Seed is
 * deterministic and idempotent: register each manifest model in the provider
 * catalog with its manifest capabilities, role-tag it in the registry (the
 * single role/scoring record, D5 — never clobbering a tested entry), and write
 * the default pins for roles that do not already carry one. Pin CRUD
 * is thin store access with the same structured-error envelope as every other
 * tool.
 *
 * Security (D12): this module only writes the provider model catalog, the
 * registry, and role pins — never any API-key material.
 */
import { NanitesError } from "../helpers/errors.js";
import { requireActiveProfile } from "../tools/deps.js";
import { ProviderModelStore } from "../storage/providerModelStore.js";
import { RolePinStore } from "../storage/rolePinStore.js";
import { stalePin } from "./resolveRoleModel.js";
import { CLOUDFLARE_AGENT_MANIFEST, CLOUDFLARE_DEFAULT_PINS, } from "../seed/cloudflareAgentManifest.js";
export const SEED_PROVIDERS = ["cloudflare"];
export function profileFor(deps, name) {
    if (name) {
        const profile = deps.profiles.getProfile(name);
        if (!profile) {
            throw new NanitesError({ code: "unknown_profile", message: `Unknown profile '${name}'.`, retryable: false });
        }
        return profile;
    }
    return requireActiveProfile(deps);
}
function sameRoleSet(a, b) {
    if (a.length !== b.length)
        return false;
    const set = new Set(a);
    return b.every((r) => set.has(r));
}
/** Untested placeholder registry row (role-tag only, no scoring evidence yet). */
function isPlaceholder(entry) {
    if (!entry)
        return true;
    if (entry.last_tested !== null)
        return false;
    return Object.values(entry.scores ?? {}).every((s) => !s || s <= 0);
}
export function seedProviderModels(deps, input) {
    const profile = profileFor(deps, input.profile);
    const provider = input.provider ?? "cloudflare";
    if (!SEED_PROVIDERS.includes(provider)) {
        throw new NanitesError({
            code: "no_seed_manifest_for_provider",
            message: `No seed manifest for provider '${provider}'. Only ${SEED_PROVIDERS.join(", ")} has a canonical agentic-model manifest.`,
            retryable: false,
        });
    }
    const prov = provider;
    const manifestById = new Map(CLOUDFLARE_AGENT_MANIFEST.map((m) => [m.model_id, m]));
    const requested = input.model_ids?.length ? input.model_ids : [...manifestById.keys()];
    const unknown = requested.filter((id) => !manifestById.has(id));
    if (unknown.length > 0) {
        // D11: refuse before any write — never a partial seed.
        throw new NanitesError({
            code: "unknown_manifest_model",
            message: `Unknown manifest model id(s): ${unknown.join(", ")}. They are not in the Cloudflare agentic-model manifest.`,
            retryable: false,
        });
    }
    const modelStore = new ProviderModelStore(deps.db);
    const registry = deps.registry;
    const pins = new RolePinStore(deps.db);
    const models_registered = [];
    let already_registered_count = 0;
    const role_tagged = [];
    const role_tags_tested_kept = [];
    const default_pins_written = [];
    const default_pins_preserved = [];
    for (const model of requested) {
        const seed = manifestById.get(model);
        const existed = modelStore.getModel(profile.name, prov, model) !== null;
        const spec = {
            model_id: seed.model_id,
            context_length: seed.context_length,
            vision: seed.vision,
            function_calling: seed.function_calling,
            reasoning: seed.reasoning,
            pricing_prompt: seed.pricing_prompt,
            pricing_completion: seed.pricing_completion,
        };
        modelStore.registerManifestModel(profile.name, prov, spec);
        if (existed)
            already_registered_count += 1;
        models_registered.push({ model_id: seed.model_id, roles: seed.roles, vision: seed.vision });
        // Role-tag in the registry — D5/D6 (vision models auto-carry the vision
        // role via the manifest). Never clobber a tested entry's real scores.
        const existing = registry.get(profile.name, model);
        if (isPlaceholder(existing)) {
            // Idempotence: a placeholder already role-tagged with these exact roles
            // needs no rewrite on re-seed — only genuinely new/divergent tags upsert.
            const sameTags = existing !== null && sameRoleSet(existing.roles, seed.roles);
            if (!sameTags) {
                registry.upsert(profile.name, {
                    model_id: model,
                    provider: prov,
                    roles: seed.roles,
                    scores: {},
                    best_params: {},
                    last_tested: null,
                });
                role_tagged.push(model);
            }
        }
        else {
            role_tags_tested_kept.push(model);
        }
        // Default pins whose target is this model, only where none exists yet.
        for (const pin of CLOUDFLARE_DEFAULT_PINS) {
            if (pin.model_id !== model)
                continue;
            if (pins.get(profile.name, pin.role)) {
                default_pins_preserved.push(pin.role);
                continue;
            }
            pins.set(profile.name, { role: pin.role, provider: prov, model_id: pin.model_id });
            default_pins_written.push({ role: pin.role, model_id: pin.model_id });
        }
    }
    return {
        profile: profile.name,
        provider: prov,
        models_registered,
        registered_count: requested.length,
        already_registered_count,
        role_tagged,
        role_tags_tested_kept,
        default_pins_written,
        default_pins_preserved,
    };
}
export function setRolePin(deps, input) {
    const profile = profileFor(deps, input.profile);
    const pins = new RolePinStore(deps.db);
    const replaced = pins.get(profile.name, input.role) !== null;
    pins.set(profile.name, { role: input.role, provider: input.provider, model_id: input.model_id });
    return { role: input.role, provider: input.provider, model_id: input.model_id, replaced };
}
export function listRolePins(deps, profileName) {
    const profile = profileFor(deps, profileName);
    const pins = new RolePinStore(deps.db).list(profile.name).map((p) => {
        const report = stalePin(deps, profile, p);
        return {
            role: p.role,
            provider: p.provider,
            model_id: p.model_id,
            updated_at: p.updated_at ?? null,
            stale: report.stale,
            stale_reason: report.reason,
            last_mismatch_at: p.last_mismatch_at ?? null,
            last_mismatch_reason: p.last_mismatch_reason ?? null,
        };
    });
    return { profile: profile.name, pins };
}
export function deleteRolePin(deps, profileName, role) {
    const profile = profileFor(deps, profileName);
    const pins = new RolePinStore(deps.db);
    return { role, removed: pins.remove(profile.name, role) };
}
