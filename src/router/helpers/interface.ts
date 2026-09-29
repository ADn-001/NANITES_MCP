/**
 * Optional helper models.
 *
 * The contract that matters is NOT what these add — it is that the router is
 * complete and correct without them. Every helper is optional, every call
 * site has a defined fallback, and the router's import graph never requires a
 * helper module to load. That is checked by tests that run with both helpers
 * absent.
 *
 * Both verified against the real packages on 2026-09-29 rather than against
 * their documentation:
 *
 *  - Needle 3 (`cactus-needle` 3.0.6, Apache-2.0, 121M). Real API:
 *      Needle().extract(text, schema=<dataclass>)  -> typed dict
 *      Needle().embed(text)                        -> 3072-dim vector
 *      Needle(tools=[...]).run(text)               -> EXECUTES the tools
 *      Needle().complete(text, max_new_tokens)     -> raw completion
 *    `extract` and `embed` are used. `run` is NOT, for tool-call repair —
 *    see the note on repair below.
 *
 *  - Laya (`convaiinnovations/laya-typed-decisions`, Apache-2.0, 421M).
 *    Typed `choice` / `score` questions returning calibrated probabilities.
 */

export interface HelperModel {
  readonly name: string;
  /** False when the helper is not installed, not enabled, or failed to load. */
  available(): boolean;
  /** Best-effort, never throws. A slow or broken helper degrades to a fallback. */
  classify(state: string, options: string[]): Promise<{ choice: string | null; confidence: number }>;
  score(state: string, criteria: string[]): Promise<{ score: number | null }>;
  retrieve(query: string, corpus: string[]): Promise<{ indices: number[] }>;
  extract<T>(text: string, schema: Record<string, unknown>): Promise<T | null>;
}

export class UnavailableHelper implements HelperModel {
  constructor(public readonly name: string, private readonly reason: string) {}
  available(): boolean {
    return false;
  }
  async classify(): Promise<{ choice: string | null; confidence: number }> {
    return { choice: null, confidence: 0 };
  }
  async score(): Promise<{ score: number | null }> {
    return { score: null };
  }
  async retrieve(): Promise<{ indices: number[] }> {
    return { indices: [] };
  }
  async extract(): Promise<null> {
    return null;
  }
  /** Never surfaced to a caller; useful in health output. */
  why(): string {
    return this.reason;
  }
}
