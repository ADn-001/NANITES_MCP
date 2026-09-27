/** Model-key substrings that mark a model as reasoning-capable. Deliberately
 * conservative: `deepseek-coder-v2-lite` is non-reasoning, so bare `deepseek`
 * is NOT a hint (only `deepseek-r` / `deepseek-v4` are). */
const REASONING_NAME_HINTS = ["qwen3", "qwen3.5", "deepseek-r", "deepseek-v4", "o1", "o3", "reason", "thinking"];
/** Conservative first-touch seed before run evidence refines it. */
export function seedReasoningType(modelId) {
    const id = modelId.toLowerCase();
    return REASONING_NAME_HINTS.some((h) => id.includes(h)) ? "reasoning" : "unknown";
}
/** Effort maps to a fraction of the profile's output-token ceiling. */
export const EFFORT_FRACTION = {
    low: 1 / 8,
    medium: 1 / 2,
    high: 1,
};
/** Roles that benefit from reasoning under medium (and always under high) effort. */
export const DIFFICULT_ROLES = new Set([
    "code_writer",
    "refactorer",
    "code_qa",
    "test_writer",
    "reviewer",
]);
/** Baseline generation time (ms) before the output-budget term is added. */
export const GEN_TIMEOUT_BASE_MS = {
    low: 20_000,
    medium: 60_000,
    high: 120_000,
};
export const GEN_TIMEOUT_FLOOR_MS = 30_000;
export const GEN_TIMEOUT_CEIL_MS = 300_000;
/** Doubling factor for models that reason (or are still unknown). */
export const GEN_TIMEOUT_REASONING_MULT = 2;
/** Assumed tokens/sec used to convert the output budget into wall-clock time. */
export const GEN_TPS = 40;
/** Extra context reserved for reasoning tokens (medium/high effort only). */
export const REASONING_HEADROOM = {
    low: 0,
    medium: 2048,
    high: 2048,
};
/**
 * Thinking-token cap (`reasoning_budget`) as a multiple of the output budget,
 * scaled by effort. Only meaningful when reasoning is "on"; higher effort gives
 * the model more thinking room relative to its answer budget.
 */
export const REASONING_BUDGET_MULT = {
    low: 1,
    medium: 1.25,
    high: 1.5,
};
/** Fixed safety padding on top of the input + output + headroom sum. */
export const CONTEXT_PADDING = 1024;
/** Context length is rounded up to a multiple of this. */
export const CONTEXT_ROUND = 512;
function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}
function roundUp(v, multiple) {
    return Math.ceil(v / multiple) * multiple;
}
export function planInference(input) {
    const fraction = EFFORT_FRACTION[input.effort];
    const max_output_tokens = Math.max(1, Math.round(input.outputTokenCeiling * fraction));
    // Reasoning decision:
    //  - low effort: suppress thinking by sending "off" (reasoning-on-by-default
    //    models like qwen3.5 would otherwise burn the whole budget on reasoning
    //    tokens and return an empty answer). Never send a flag to a known
    //    non-reasoning model (no config to toggle) — just omit.
    //  - medium (difficult roles only) / high: reasoning "on".
    //  - any level on a known non-reasoning model: omit the flag, with a note.
    let reasoning;
    let note;
    if (input.effort === "low") {
        if (input.reasoningType === "non_reasoning")
            reasoning = undefined;
        else
            reasoning = "off";
    }
    else {
        const wantsReasoning = input.effort === "high" || DIFFICULT_ROLES.has(input.role);
        if (wantsReasoning && input.reasoningType === "non_reasoning") {
            reasoning = undefined;
            note = `${input.effort} effort, non-reasoning model — reasoning skipped`;
        }
        else if (wantsReasoning) {
            reasoning = "on";
        }
    }
    // Thinking-token cap. Only sent when reasoning is actually on; derived from
    // the output budget scaled by effort, or the explicit override if given.
    let reasoning_budget;
    if (reasoning === "on") {
        reasoning_budget = input.reasoningBudgetOverride ?? Math.round(max_output_tokens * REASONING_BUDGET_MULT[input.effort]);
    }
    // Context: reserve input + output budget + reasoning headroom + padding,
    // clamped to the model's max and rounded to a friendly multiple.
    const headroom = REASONING_HEADROOM[input.effort];
    const desired = input.promptTokens + max_output_tokens + headroom + CONTEXT_PADDING;
    const context_length = roundUp(clamp(desired, CONTEXT_ROUND, input.maxContextLength), CONTEXT_ROUND);
    // Generation timeout: baseline by effort + time to emit the budget at a
    // typical t/s, doubled for models that reason (they burn the first chunk on
    // reasoning tokens before any answer token).
    const base = GEN_TIMEOUT_BASE_MS[input.effort];
    const outputTimeMs = (max_output_tokens / GEN_TPS) * 1000;
    const reasoningMult = input.reasoningType === "reasoning" || input.reasoningType === "unknown" ? GEN_TIMEOUT_REASONING_MULT : 1;
    if (input.unknownContextCeiling) {
        note = [
            note,
            "model context ceiling unknowable (model discovery failed) — planned against the default 32768 ceiling",
        ]
            .filter((n) => Boolean(n))
            .join("; ");
    }
    const generation_timeout_ms = clamp(Math.round(base + outputTimeMs) * reasoningMult, GEN_TIMEOUT_FLOOR_MS, GEN_TIMEOUT_CEIL_MS);
    return {
        max_output_tokens,
        reasoning,
        ...(reasoning_budget !== undefined ? { reasoning_budget } : {}),
        context_length,
        generation_timeout_ms,
        ...(note ? { note } : {}),
    };
}
