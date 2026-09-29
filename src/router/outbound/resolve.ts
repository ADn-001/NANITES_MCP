/**
 * Resolve an inbound `model` string to a concrete (provider, endpoint, model_id).
 *
 * Deliberately dumb in R1: aliases land in R4. What this does NOT do is guess.
 * A bare model id that two providers serve is REJECTED with the candidates
 * named, because picking the first match is the exact ambiguity that made the
 * MCP server's cloud routing wrong before it was fixed.
 */
import type { DatabaseSync } from "node:sqlite";
import { NanitesError } from "../../helpers/errors.js";
import { parseModelId, providerOfModelId, isNamespaced } from "../../storage/providerModelId.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import { ProviderKeyStore } from "../../storage/providerKeyStore.js";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import { ROUTER_PROFILE } from "../constants.js";
import { getAdvertised } from "../models/catalog.js";

export interface ResolvedTarget {
  provider: ProviderKind;
  endpoint: string | null;
  model_id: string;
  /** The namespaced id, which is what the outbound layer sends. */
  stored_id: string;
}

const VALID_PROVIDERS: ReadonlySet<string> = new Set([
  "local", "cloudflare", "openrouter", "omniroute", "generic", "nvidia",
]);

function unknownModel(id: string, candidates: string[]): NanitesError {
  return new NanitesError({
    code: "alias_unknown",
    message: candidates.length
      ? `"${id}" is served by more than one provider: ${candidates.join(", ")}. Send a namespaced id such as "${candidates[0]}".`
      : `No configured provider serves the model "${id}".`,
    retryable: false,
    details: { model: id, candidates },
  });
}

export function resolveTarget(db: DatabaseSync, model: string): ResolvedTarget {
  const id = model.trim();
  if (!id) {
    throw new NanitesError({
      code: "alias_unknown",
      message: "model is required",
      retryable: false,
    });
  }

  // 0. An ADVERTISED alias. Checked FIRST, and it is what makes a
  //    harness-safe name work: the harness sends `nanites-flash` and it
  //    resolves to the real namespaced id behind it.
  const advertised = getAdvertised(db, id);
  if (advertised) {
    return {
      provider: advertised.provider as ProviderKind,
      endpoint: null,
      model_id: advertised.real_id,
      stored_id: advertised.real_id,
    };
  }

  // 1. Already namespaced: `provider:model` or `generic:<endpoint>:model`.
  if (isNamespaced(id)) {
    const parsed = parseModelId(id);
    if (!parsed.provider || !VALID_PROVIDERS.has(parsed.provider)) {
      throw new NanitesError({
        code: "alias_unknown",
        message: `"${id}" names an unknown provider "${parsed.provider}".`,
        retryable: false,
        details: { model: id, provider: parsed.provider },
      });
    }
    return {
      provider: parsed.provider as ProviderKind,
      endpoint: parsed.endpoint,
      model_id: parsed.model_id,
      stored_id: id,
    };
  }

  // 2. A bare id. Search the catalog; refuse to guess.
  const store = new ProviderModelStore(db);
  const all = store.listModels(ROUTER_PROFILE);
  const exact = all.filter((m) => m.model_id === id);

  if (exact.length === 1) {
    const m = exact[0]!;
    return {
      provider: m.provider,
      endpoint: null,
      model_id: m.model_id,
      stored_id: `${m.provider}:${m.model_id}`,
    };
  }

  if (exact.length > 1) {
    throw unknownModel(id, exact.map((m) => `${m.provider}:${m.model_id}`));
  }

  // 3. Not in the catalog. A model can still be callable if the provider is
  //    configured and accepts it — the catalog is a discovery cache, not an
  //    allowlist, and refusing here would break every model added since the
  //    last discovery run. But it must be UNAMBIGUOUS across configured
  //    providers, so ask the key store which providers exist at all.
  const keyStore = new ProviderKeyStore(db);
  const configured = [...VALID_PROVIDERS]
    .filter((p) => p !== "local")
    .filter((p) => keyStore.listKeys(ROUTER_PROFILE, p as ProviderKind).length > 0);

  if (configured.length === 1) {
    const provider = configured[0] as ProviderKind;
    return { provider, endpoint: null, model_id: id, stored_id: `${provider}:${id}` };
  }

  if (configured.length > 1) {
    throw unknownModel(id, configured.map((p) => `${p}:${id}`));
  }

  throw new NanitesError({
    code: "provider_key_required",
    message: `No provider is configured, so "${id}" cannot be routed. Add a provider key first.`,
    retryable: false,
    details: { model: id },
  });
}

/** Every provider that could serve `model`, for diagnostics. */
export function candidateTargets(db: DatabaseSync, model: string): string[] {
  const store = new ProviderModelStore(db);
  const id = model.trim();
  return store
    .listModels(ROUTER_PROFILE)
    .filter((m) => m.model_id === id)
    .map((m) => `${m.provider}:${m.model_id}`);
}

export { providerOfModelId };
