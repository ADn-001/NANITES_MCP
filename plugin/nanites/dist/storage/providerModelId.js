/** Separator between the provider and the provider-native id. Chosen because
 *  it cannot appear in a provider's own id: Cloudflare ids start with `@cf/`,
 *  the others use `/` and `:` but never a leading `provider:` prefix. */
export const PROVIDER_ID_SEPARATOR = ":";
/** Build the stored id for a model on a provider. */
export function namespaceModelId(provider, modelId, endpoint) {
    if (provider === "local")
        return `local${PROVIDER_ID_SEPARATOR}${modelId}`;
    // A generic gateway is one of many, so the endpoint name is part of the
    // identity: two gateways serving `deepseek-v4` are different accounts.
    if (provider === "generic" && endpoint) {
        return `${provider}${PROVIDER_ID_SEPARATOR}${endpoint}${PROVIDER_ID_SEPARATOR}${modelId}`;
    }
    return `${provider}${PROVIDER_ID_SEPARATOR}${modelId}`;
}
/** Parse a stored id back into its parts. Never throws. */
export function parseModelId(stored) {
    const raw = String(stored ?? "");
    const head = raw.split(PROVIDER_ID_SEPARATOR, 1)[0] ?? "";
    const isKind = (h) => h === "cloudflare" || h === "openrouter" || h === "omniroute" || h === "generic" || h === "local";
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
export function wireModelId(stored) {
    return parseModelId(stored).model_id;
}
/** The provider a stored id belongs to, or null when it carries no namespace. */
export function providerOfModelId(stored) {
    return parseModelId(stored).provider;
}
/** True when the id already carries a namespace (so callers can migrate once). */
export function isNamespaced(stored) {
    return parseModelId(stored).namespaced;
}
/**
 * Whether a stored id looks like it belongs to `provider` on `endpoint`.
 * Used by the catalog and leaderboard so a legacy row is still matched by the
 * provider it was registered under, rather than being orphaned by namespacing.
 */
export function idBelongsTo(stored, provider, endpoint) {
    const parsed = parseModelId(stored);
    if (parsed.provider !== null) {
        if (parsed.provider !== provider)
            return false;
        if (provider === "generic" && endpoint)
            return parsed.endpoint === endpoint;
        return true;
    }
    return false;
}
