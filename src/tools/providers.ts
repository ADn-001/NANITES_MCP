/**
 * Provider management MCP tools: add/remove/list keys, discover/register models,
 * show errors, and provider settings.
 */
import type { ToolDeps } from "./deps.js";
import { NanitesError } from "../helpers/errors.js";
import { createProviderClient, GenericClient } from "../providers/client.js";
import { ProviderKeyStore } from "../storage/providerKeyStore.js";
import { ProviderModelStore } from "../storage/providerModelStore.js";
import { ProviderErrorStore } from "../storage/providerErrorStore.js";
import { ProviderStickyStore } from "../storage/providerStickyStore.js";
import { requireActiveProfile } from "./deps.js";
import type { ProviderKind } from "../storage/profileDefaults.js";
import { clearProfileBinding } from "../router/constants.js";
import { discoverModels } from "../router/providers/discover.js";

const VALID_PROVIDERS: ProviderKind[] = ["cloudflare", "openrouter", "nvidia", "omniroute", "generic"];

function validateProvider(p: string): ProviderKind {
  if (VALID_PROVIDERS.includes(p as ProviderKind)) return p as ProviderKind;
  throw new NanitesError({
    code: "invalid_arguments",
    message: `Provider must be one of: ${VALID_PROVIDERS.join(", ")}. Got: ${p}`,
    retryable: false,
  });
}

// ---- key management ----

export function addProviderKey(deps: ToolDeps, provider: string, apiKey: string, opts?: { accountId?: string; gatewayUrl?: string; nickname?: string }) {
  const profile = requireActiveProfile(deps);
  const prov = validateProvider(provider);
  const keyStore = new ProviderKeyStore(deps.db);
  const keyId = keyStore.addKey(profile.name, prov, apiKey, opts);
  // The router resolves the ACTIVE profile, cached against the pointer file's
  // mtime. Dropping the cache here means a key added in the Providers tab is
  // usable by a running gateway on its very next request, with no restart and
  // no dependency on filesystem timestamp granularity.
  clearProfileBinding();
  return { key_id: keyId, provider: prov, message: `API key added for ${prov}.` };
}

export function removeProviderKey(deps: ToolDeps, provider: string, keyId: string) {
  const profile = requireActiveProfile(deps);
  const prov = validateProvider(provider);
  const keyStore = new ProviderKeyStore(deps.db);
  keyStore.removeKey(profile.name, prov, keyId);
  clearProfileBinding();
  return { message: `Key removed from ${prov}.` };
}

export function listProviderKeys(deps: ToolDeps, provider: string) {
  const profile = requireActiveProfile(deps);
  const prov = validateProvider(provider);
  const keyStore = new ProviderKeyStore(deps.db);
  const keys = keyStore.listKeys(profile.name, prov);
  return {
    provider: prov,
    keys: keys.map((k) => ({
      key_id: k.key_id,
      // The nickname is the endpoint's name: a generic profile holds many
      // OpenAI-compatible gateways, and without this the list is a wall of
      // anonymous URLs. It is also what a `generic:<endpoint>:<model>` id
      // resolves to when routing.
      nickname: k.nickname ?? null,
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

export function toggleProviderKey(deps: ToolDeps, provider: string, keyId: string, enabled: boolean) {
  const profile = requireActiveProfile(deps);
  const prov = validateProvider(provider);
  const keyStore = new ProviderKeyStore(deps.db);
  keyStore.setEnabled(profile.name, prov, keyId, enabled);
  return { key_id: keyId, is_enabled: enabled };
}

// ---- model management ----

export async function discoverProviderModels(deps: ToolDeps, provider: string) {
  const profile = requireActiveProfile(deps);
  const prov = validateProvider(provider);

  // The shared implementation, so the Providers tab and the router discover
  // IDENTICALLY. This copy used to hardcode the omniroute base URL while the
  // router honoured the key's `gateway_url` -- so a key with a custom gateway
  // was discovered here and not there, which reads as "the provider has no
  // models" rather than as a bug.
  const outcome = await discoverModels(deps.db, prov, { profile: profile.name });
  if (!outcome.ok) {
    throw new NanitesError({
      code: outcome.code,
      message: outcome.message,
      retryable: false,
      details: { provider: prov },
    });
  }

  // Re-read for the preview list. The upsert already happened inside the shared
  // function; this only shapes what goes into the orchestrator's context.
  const stored = new ProviderModelStore(deps.db)
    .listModels(profile.name, prov)
    .filter((m) => m.is_registered);

  return {
    provider: prov,
    discovered: outcome.model_count,
    // Truncated on purpose: this result goes into the orchestrator's context,
    // which has a budget the gateway's catalog endpoint does not.
    models: stored.slice(0, 20).map((m) => ({
      id: m.model_id,
      name: m.name ?? m.model_id,
      owned_by: m.owned_by,
      context_length: m.context_window,
    })),
    note: `Discovered ${outcome.model_count} models. Use /nanites-registerModel to register specific ones.`,
  };
}

export function listProviderModels(deps: ToolDeps, provider: string, registeredOnly?: boolean) {
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

export function registerProviderModel(deps: ToolDeps, provider: string, modelId: string) {
  const profile = requireActiveProfile(deps);
  const prov = validateProvider(provider);
  const modelStore = new ProviderModelStore(deps.db);
  modelStore.registerModel(profile.name, prov, modelId);
  return { provider: prov, model_id: modelId, message: `${prov} model '${modelId}' registered.` };
}

export function deregisterProviderModel(deps: ToolDeps, provider: string, modelId: string) {
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

export function showProviderErrors(deps: ToolDeps, filter?: string) {
  const profile = requireActiveProfile(deps);
  const errorStore = new ProviderErrorStore(deps.db);

  let days: number | undefined;
  if (filter === "today") days = 1;
  else if (filter && /^\d+$/.test(filter)) days = Math.min(5, Math.max(1, parseInt(filter, 10)));

  const errors = errorStore.list(profile.name, { days });
  if (errors.length === 0) return { message: "No errors found.", errors: [] };

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

export function setProviderEnabled(deps: ToolDeps, provider: string, enabled: boolean) {
  const profile = requireActiveProfile(deps);
  const prov = validateProvider(provider);
  if (!profile.providers) profile.providers = {};
  if (!profile.providers[prov]) profile.providers[prov] = { enabled: true };
  profile.providers[prov]!.enabled = enabled;
  deps.profiles.updateProfile(profile.name, { name: profile.name, providers: profile.providers });
  return { provider: prov, enabled };
}

export function getProviderConfig(deps: ToolDeps) {
  const profile = requireActiveProfile(deps);
  return {
    preference_order: profile.provider_preference_order,
    providers: profile.providers,
  };
}

export function setProviderPreferenceOrder(deps: ToolDeps, order: ProviderKind[]) {
  const profile = requireActiveProfile(deps);
  deps.profiles.updateProfile(profile.name, { name: profile.name, provider_preference_order: order });
  return { preference_order: order };
}
