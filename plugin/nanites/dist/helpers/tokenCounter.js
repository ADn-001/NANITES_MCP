import { countTokens } from "./tokenize.js";
export { countTokens } from "./tokenize.js";
/** Authoritative counts from a chat response's stats. */
export function usageFromStats(stats) {
    return {
        inputTokens: stats.input_tokens,
        outputTokens: stats.total_output_tokens,
        reasoningTokens: stats.reasoning_output_tokens ?? 0,
    };
}
/** Estimate for a call that never reached the API or lacked stats. */
export function usageEstimate(inputTexts, outputText) {
    const input = inputTexts.reduce((sum, t) => sum + countTokens(t), 0);
    return { inputTokens: input, outputTokens: countTokens(outputText), reasoningTokens: 0 };
}
