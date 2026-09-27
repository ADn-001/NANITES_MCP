/** Rough estimate: ~4 characters per token. Never throws on any input. */
export function countTokens(text) {
    if (text.length === 0)
        return 0;
    return Math.max(1, Math.round(text.length / 4));
}
let defaultProvider = null;
/** Install a process-wide default provider (used when a call omits one). */
export function setTokenizerProvider(provider) {
    defaultProvider = provider;
}
export function getTokenizerProvider() {
    return defaultProvider;
}
/** Accurate count via the active provider; falls back to chars/4 on any
 * failure, unresolved model, or when no provider is available. Never throws. */
export async function countTokensAccurate(text, opts = {}) {
    const provider = opts.provider !== undefined ? opts.provider : defaultProvider;
    if (provider) {
        try {
            const n = await provider.count(text, opts);
            if (typeof n === "number" && Number.isFinite(n) && n >= 0)
                return Math.floor(n);
        }
        catch {
            // Provider failure is not a failure of the seam — fall through.
        }
    }
    return countTokens(text);
}
