/**
 * Provider-namespaced model ids.
 *
 * A model id on its own is not an identity: the same id can be served by more
 * than one provider (`qwen/qwen3.8-27b:free` on OpenRouter and behind an
 * OpenAI-compatible gateway, say), and providers are separate accounts with
 * separate keys and separate billing. Every consumer that grouped by
 * `model_id` alone therefore collapsed them — the leaderboard dropped a
 * provider's copy of an id another provider had tested, and the cost report
 * attributed cloud spend to whichever row was created first.
 *
 * The id stored in the catalog is namespaced, so the namespace travels with
 * the value and no consumer has to remember to pair it with a provider:
 *
 *   cloudflare:@cf/meta/llama-3.2-3b-instruct
 *   openrouter:qwen/qwen3.8-27b:free
 *   generic:codecraftapi:deepseek-v4-flash   (named endpoint, see below)
 *   local:qwen3.5-0.8b
 *
 * The wire id a provider expects is recovered by `wireModelId`, so nothing
 * off-box changes. Legacy un-namespaced ids parse as provider-less and are
 * reported by `isNamespaced` so a migration can find them.
 */
import type { ProviderKind } from "./profileDefaults.js";

/** Separator between the provider and the provider-native id. Chosen because
 *  it cannot appear in a provider's own id: Cloudflare ids start with `@cf/`,
 *  the others use `/` and `:` but never a leading `provider:` prefix. */
export const PROVIDER_ID_SEPARATOR = ":";

export interface NamespacedModelId {
  /** The provider kind, or null for a legacy id with no namespace. */
  provider: ProviderKind | null;
  /** For a generic endpoint, the user's name for that endpoint. */
  endpoint: string | null;
  /** The id exactly as the provider's API knows it. */
  model_id: string;
  /** True when the id carried a provider namespace. */
  namespaced: boolean;
}

/** Build the stored id for a model on a provider. */
export function namespaceModelId(
  provider: ProviderKind,
  modelId: string,
  endpoint?: string | null,
): string {
  if (provider === "local") return `local${PROVIDER_ID_SEPARATOR}${modelId}`;
  // A generic gateway is one of many, so the endpoint name is part of the
  // identity: two gateways serving `deepseek-v4` are different accounts.
  if (provider === "generic" && endpoint) {
    return `${provider}${PROVIDER_ID_SEPARATOR}${endpoint}${PROVIDER_ID_SEPARATOR}${modelId}`;
  }
  return `${provider}${PROVIDER_ID_SEPARATOR}${modelId}`;
}

/** Parse a stored id back into its parts. Never throws. */
export function parseModelId(stored: string): NamespacedModelId {
  const raw = String(stored ?? "");
  const head = raw.split(PROVIDER_ID_SEPARATOR, 1)[0] ?? "";
  const isKind = (h: string): h is ProviderKind =>
    h === "cloudflare" || h === "openrouter" || h === "omniroute" || h === "generic" || h === "nvidia" || h === "local";

  if (!isKind(head)) {
    return { provider: null, endpoint: null, model_id: raw, namespaced: false };
  }
  const rest = raw.slice(head.length + 1);
  if (head === "generic") {
    // generic:<endpoint>:<model> — the model itself may contain colons.
    const second = rest.indexOf(PROVIDER_ID_SEPARATOR);
    if (second > 0) {
      return {
        provider: "generic",
        endpoint: rest.slice(0, second),
        model_id: rest.slice(second + 1),
        namespaced: true,
      };
    }
    return { provider: "generic", endpoint: null, model_id: rest, namespaced: true };
  }
  return { provider: head, endpoint: null, model_id: rest, namespaced: true };
}

/** The id to put on the wire. Namespaced or legacy, both reduce correctly. */
export function wireModelId(stored: string): string {
  return parseModelId(stored).model_id;
}

/** The provider a stored id belongs to, or null when it carries no namespace. */
export function providerOfModelId(stored: string): ProviderKind | null {
  return parseModelId(stored).provider;
}

/** True when the id already carries a namespace (so callers can migrate once). */
export function isNamespaced(stored: string): boolean {
  return parseModelId(stored).namespaced;
}

/**
 * Whether a stored id looks like it belongs to `provider` on `endpoint`.
 * Used by the catalog and leaderboard so a legacy row is still matched by the
 * provider it was registered under, rather than being orphaned by namespacing.
 */
export function idBelongsTo(
  stored: string,
  provider: ProviderKind,
  endpoint?: string | null,
): boolean {
  const parsed = parseModelId(stored);
  if (parsed.provider !== null) {
    if (parsed.provider !== provider) return false;
    if (provider === "generic" && endpoint) return parsed.endpoint === endpoint;
    return true;
  }
  return false;
}
