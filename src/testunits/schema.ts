/**
 * Test-unit schema, §5 of the project instructions. The validator lives in
 * validator.ts; the built-in set lives in defaultRegimen.ts.
 */
export const MEASURES = [
  "quality",
  "latency",
  "instruction_following",
  "role_fitness",
  "honesty",
  "format_compliance",
] as const;
export type Measure = (typeof MEASURES)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const SCORING_METHODS = ["deterministic_rule", "orchestrator_judged"] as const;
export type ScoringMethod = (typeof SCORING_METHODS)[number];

export const RULE_TYPES = ["json_valid", "exact_match", "regex_match", "label_in_set"] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const KV_CACHE_QUANTS = ["Q8", "Q4", "F16"] as const;
export type KvCacheQuant = (typeof KV_CACHE_QUANTS)[number];

export const UNIT_SOURCES = ["default_regimen", "custom_authored"] as const;
export type UnitSource = (typeof UNIT_SOURCES)[number];

export interface PromptSpec {
  id: string;
  text: string;
  expected?: string | null;
  notes?: string | null;
}

export interface RecommendedConfig {
  context_length: number;
  kv_cache_quant: KvCacheQuant;
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
  max_output_tokens: number;
}

export interface ScoringSpec {
  method: ScoringMethod;
  /** Required when method = deterministic_rule. */
  rule?: {
    type: RuleType;
    params: Record<string, unknown>;
  };
  /** Required (non-trivial) when method = orchestrator_judged. */
  rubric?: string;
}

export interface TestUnit {
  id: string;
  name: string;
  task_group: string;
  difficulty: Difficulty;
  prompts: PromptSpec[];
  measures: Measure[];
  applicable_roles: string[];
  recommended_config: RecommendedConfig;
  scoring: ScoringSpec;
  source: UnitSource;
  version: number;
}
