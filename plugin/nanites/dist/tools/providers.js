import { NanitesError } from "../helpers/errors.js";
import { createProviderClient, GenericClient } from "../providers/client.js";
import { ProviderKeyStore } from "../storage/providerKeyStore.js";
import { ProviderModelStore } from "../storage/providerModelStore.js";
import { ProviderErrorStore } from "../storage/providerErrorStore.js";
import { ProviderStickyStore } from "../storage/providerStickyStore.js";
import { requireActiveProfile } from "./deps.js";
const VALID_PROVIDERS = ["cloudflare", "openrouter", "omniroute", "generic"];
function validateProvider(p) {
    if (VALID_PROVIDERS.includes(p))
        return p;
    throw new NanitesError({
        code: "invalid_arguments",
        message: `Provider must be one of: ${VALID_PROVIDERS.join(", ")}. Got: ${p}`,
        retryable: false,
    });
}
// ---- key management ----
export function addProviderKey(deps, provider, apiKey, opts) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const keyStore = new ProviderKeyStore(deps.db);
    const keyId = keyStore.addKey(profile.name, prov, apiKey, opts);
    return { key_id: keyId, provider: prov, message: `API key added for ${prov}.` };
}
export function removeProviderKey(deps, provider, keyId) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const keyStore = new ProviderKeyStore(deps.db);
    keyStore.removeKey(profile.name, prov, keyId);
    return { message: `Key removed from ${prov}.` };
}
export function listProviderKeys(deps, provider) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const keyStore = new ProviderKeyStore(deps.db);
    const keys = keyStore.listKeys(profile.name, prov);
    return {
        provider: prov,
        keys: keys.map((k) => ({
            key_id: k.key_id,
            account_id: k.account_id,
            gateway_url: k.gateway_url,
            is_enabled: k.is_enabled,
            is_exhausted: k.is_exhausted,
            exhausted_until: k.exhausted_until,
            consecutive_failures: k.consecutive_failures,
            created_at: k.created_at,
        })),
    };
}
export function toggleProviderKey(deps, provider, keyId, enabled) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const keyStore = new ProviderKeyStore(deps.db);
    keyStore.setEnabled(profile.name, prov, keyId, enabled);
    return { key_id: keyId, is_enabled: enabled };
}
// ---- model management ----
export async function discoverProviderModels(deps, provider) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const keyStore = new ProviderKeyStore(deps.db);
    const modelStore = new ProviderModelStore(deps.db);
    const keys = keyStore.availableKeys(profile.name, prov);
    if (keys.length === 0) {
        throw new NanitesError({
            code: "all_keys_exhausted",
            message: `No available API keys for ${prov}. Add a key first.`,
            retryable: false,
        });
    }
    const key = keys[0];
    const baseUrl = prov === "omniroute" ? "http://localhost:20128/v1"
        : prov === "generic" ? (key.gateway_url ?? "http://localhost:8080/v1")
            : undefined;
    const client = createProviderClient(prov, baseUrl);
    let result;
    if (prov === "cloudflare") {
        if (!key.account_id)
            throw new NanitesError({ code: "invalid_arguments", message: "Cloudflare key requires account_id", retryable: false });
        result = await client.listModels(key.api_key, key.account_id);
    }
    else if (prov === "openrouter") {
        result = await client.listModels(key.api_key);
    }
    else {
        // Generic / OmniRoute: base URL from key
        const base = prov === "generic" ? (key.gateway_url ?? "http://localhost:8080/v1") : "http://localhost:20128/v1";
        const genericClient = new GenericClient(base);
        result = await genericClient.listModels(key.api_key);
    }
    modelStore.upsertModels(profile.name, prov, result.models);
    return {
        provider: prov,
        discovered: result.models.length,
        models: result.models.slice(0, 20).map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            owned_by: m.owned_by,
            context_length: m.context_length,
        })),
        note: `Discovered ${result.models.length} models. Use /nanites-registerModel to register specific ones.`,
    };
}
export function listProviderModels(deps, provider, registeredOnly) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const modelStore = new ProviderModelStore(deps.db);
    const stickyStore = new ProviderStickyStore(deps.db);
    const models = modelStore.listModels(profile.name, prov, registeredOnly);
    const sticky = stickyStore.getSticky(profile.name, prov);
    return {
        provider: prov,
        sticky_model: sticky,
        models: models.map((m) => ({
            model_id: m.model_id,
            name: m.name,
            owned_by: m.owned_by,
            is_registered: m.is_registered,
            context_window: m.context_window,
        })),
    };
}
export function registerProviderModel(deps, provider, modelId) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const modelStore = new ProviderModelStore(deps.db);
    modelStore.registerModel(profile.name, prov, modelId);
    return { provider: prov, model_id: modelId, message: `${prov} model '${modelId}' registered.` };
}
export function deregisterProviderModel(deps, provider, modelId) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    const modelStore = new ProviderModelStore(deps.db);
    const stickyStore = new ProviderStickyStore(deps.db);
    modelStore.deregisterModel(profile.name, prov, modelId);
    if (stickyStore.getSticky(profile.name, prov) === modelId) {
        stickyStore.clearSticky(profile.name, prov);
    }
    return { message: `${prov} model '${modelId}' deregistered.` };
}
// ---- error log ----
export function showProviderErrors(deps, filter) {
    const profile = requireActiveProfile(deps);
    const errorStore = new ProviderErrorStore(deps.db);
    let days;
    if (filter === "today")
        days = 1;
    else if (filter && /^\d+$/.test(filter))
        days = Math.min(5, Math.max(1, parseInt(filter, 10)));
    const errors = errorStore.list(profile.name, { days });
    if (errors.length === 0)
        return { message: "No errors found.", errors: [] };
    return {
        errors: errors.map((e) => ({
            id: e.id,
            provider: e.provider,
            model_id: e.model_id,
            error_code: e.error_code,
            error_message: e.error_message.slice(0, 200),
            http_status: e.http_status,
            retryable: e.retryable,
            retry_count: e.retry_count,
            created_at: e.created_at,
        })),
    };
}
// ---- provider settings ----
export function setProviderEnabled(deps, provider, enabled) {
    const profile = requireActiveProfile(deps);
    const prov = validateProvider(provider);
    if (!profile.providers)
        profile.providers = {};
    if (!profile.providers[prov])
        profile.providers[prov] = { enabled: true };
    profile.providers[prov].enabled = enabled;
    deps.profiles.updateProfile(profile.name, { name: profile.name, providers: profile.providers });
    return { provider: prov, enabled };
}
export function getProviderConfig(deps) {
    const profile = requireActiveProfile(deps);
    return {
        preference_order: profile.provider_preference_order,
        providers: profile.providers,
    };
}
export function setProviderPreferenceOrder(deps, order) {
    const profile = requireActiveProfile(deps);
    deps.profiles.updateProfile(profile.name, { name: profile.name, provider_preference_order: order });
    return { preference_order: order };
}
