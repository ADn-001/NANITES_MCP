/**
 * Single source of truth for the two param candidates a unit is tried under
 * (E4): `baseline` = the unit's recommended_config verbatim; `variant` = a
 * deliberately sloppier sampling config the search can prefer when it scores
 * higher. Shared by runTestRegimen (which generates the chats) and
 * submitTestJudgment (which reconstructs the judged candidate's params to log
 * to the param-search attempt table).
 */
import type { ChatRequestParams } from "../lmstudio/types.js";
import type { RecommendedConfig } from "./schema.js";

export type UnitCandidate = "baseline" | "variant";

export function paramsForCandidate(config: RecommendedConfig, candidate: UnitCandidate): ChatRequestParams {
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

export function paramsFromConfig(config: RecommendedConfig): ChatRequestParams {
  return {
    temperature: config.temperature,
    top_p: config.top_p,
    top_k: config.top_k,
    repeat_penalty: config.repeat_penalty,
    max_output_tokens: config.max_output_tokens,
    context_length: config.context_length,
  };
}
