/**
 * Usage accounting. Prefers the authoritative counts in `ChatStats` (returned
 * by LM Studio); falls back to the chars/4 seam for text that never went
 * through the API. The estimator itself lives in `./tokenize.ts` — this module
 * owns the *usage* shapes, not the count heuristic.
 */
import type { ChatStats } from "../lmstudio/types.js";
import { countTokens } from "./tokenize.js";

export { countTokens } from "./tokenize.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Authoritative counts from a chat response's stats. */
export function usageFromStats(stats: ChatStats): TokenUsage {
  return {
    inputTokens: stats.input_tokens,
    outputTokens: stats.total_output_tokens,
    reasoningTokens: stats.reasoning_output_tokens ?? 0,
  };
}

/** Estimate for a call that never reached the API or lacked stats. */
export function usageEstimate(inputTexts: string[], outputText: string): TokenUsage {
  const input = inputTexts.reduce((sum, t) => sum + countTokens(t), 0);
  return { inputTokens: input, outputTokens: countTokens(outputText), reasoningTokens: 0 };
}
