/**
 * Token-counting seam (Phase D). The single place every "how many tokens is
 * this text" question resolves through, replacing the earlier spread of
 * ad-hoc `/4` heuristics with one never-throws primitive plus a pluggable
 * async provider for model-accurate counts.
 *
 * Two entry points:
 *  - `countTokens(text)` — synchronous chars/4 fast path. Numeric behavior is
 *    pinned to the pre-seam estimator so existing callers and tests shift by
 *    nothing.
 *  - `countTokensAccurate(text, opts?)` — async; asks a provider to count
 *    against a real model tokenizer when one can be resolved, otherwise falls
 *    back to `countTokens`. Never throws: any provider that returns null,
 *    garbage, or throws just yields the chars/4 number.
 */
export interface TokenizeOptions {
  /** The LM Studio model key, used to pick a matching tokenizer family. */
  modelId?: string;
  /** Explicit HF repo id (the registry `source`) to tokenize against; wins
   * over anything derived from `modelId`. */
  repoId?: string;
  /** Provider override. `null` forces the chars/4 fallback even when a
   * default provider is registered. */
  provider?: TokenizerProvider | null;
}

/** A pluggable accurate token counter. Return null when it cannot resolve a
 * tokenizer for the model; the seam then falls back to chars/4. */
export interface TokenizerProvider {
  readonly id: string;
  count(text: string, opts: TokenizeOptions): Promise<number | null>;
}

/** Rough estimate: ~4 characters per token. Never throws on any input. */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

let defaultProvider: TokenizerProvider | null = null;

/** Install a process-wide default provider (used when a call omits one). */
export function setTokenizerProvider(provider: TokenizerProvider | null): void {
  defaultProvider = provider;
}

export function getTokenizerProvider(): TokenizerProvider | null {
  return defaultProvider;
}

/** Accurate count via the active provider; falls back to chars/4 on any
 * failure, unresolved model, or when no provider is available. Never throws. */
export async function countTokensAccurate(text: string, opts: TokenizeOptions = {}): Promise<number> {
  const provider = opts.provider !== undefined ? opts.provider : defaultProvider;
  if (provider) {
    try {
      const n = await provider.count(text, opts);
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) return Math.floor(n);
    } catch {
      // Provider failure is not a failure of the seam — fall through.
    }
  }
  return countTokens(text);
}
