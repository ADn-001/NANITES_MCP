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
];
export const DIFFICULTIES = ["easy", "medium", "hard"];
export const SCORING_METHODS = ["deterministic_rule", "orchestrator_judged"];
export const RULE_TYPES = ["json_valid", "exact_match", "regex_match", "label_in_set"];
export const KV_CACHE_QUANTS = ["Q8", "Q4", "F16"];
export const UNIT_SOURCES = ["default_regimen", "custom_authored"];
