export function paramsForCandidate(config, candidate) {
    if (candidate === "baseline") {
        return paramsFromConfig(config);
    }
    return {
        temperature: Math.min(0.8, config.temperature + 0.5),
        top_p: 0.95,
        top_k: 40,
        repeat_penalty: 1.0,
        max_output_tokens: config.max_output_tokens,
        context_length: config.context_length,
    };
}
export function paramsFromConfig(config) {
    return {
        temperature: config.temperature,
        top_p: config.top_p,
        top_k: config.top_k,
        repeat_penalty: config.repeat_penalty,
        max_output_tokens: config.max_output_tokens,
        context_length: config.context_length,
    };
}
