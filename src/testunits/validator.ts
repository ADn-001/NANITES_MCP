/**
 * Test-unit validator, enforcing every rule listed in §5 of the project
 * instructions. Pure function: unit in, issues out. Registration re-runs
 * this internally — there is no path that trusts a pre-validated flag.
 */
import {
  DIFFICULTIES,
  KV_CACHE_QUANTS,
  MEASURES,
  RULE_TYPES,
  SCORING_METHODS,
  UNIT_SOURCES,
  type Difficulty,
  type KvCacheQuant,
  type Measure,
  type RuleType,
  type ScoringMethod,
  type ScoringSpec,
  type TestUnit,
  type UnitSource,
} from "./schema.js";

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** "Non-trivial" rubric: meaningful text, not whitespace/one word. */
const MIN_RUBRIC_CHARS = 10;

export function validateTestUnit(unit: unknown, existingIds: string[] = []): ValidationResult {
  const issues: ValidationIssue[] = [];
  const u = unit as TestUnit | null;

  if (u === null || typeof u !== "object" || Array.isArray(u)) {
    return { ok: false, issues: [{ field: "unit", message: "must be an object" }] };
  }

  // id
  if (typeof u.id !== "string" || u.id.trim().length === 0) {
    issues.push({ field: "id", message: "must be a non-empty string" });
  } else if (existingIds.includes(u.id)) {
    issues.push({ field: "id", message: `duplicate id "${u.id}" within the registered set` });
  }

  if (typeof u.name !== "string" || u.name.trim().length === 0) {
    issues.push({ field: "name", message: "must be a non-empty string" });
  }

  if (typeof u.task_group !== "string" || u.task_group.trim().length === 0) {
    issues.push({ field: "task_group", message: "must be a non-empty string" });
  }

  if (!DIFFICULTIES.includes(u.difficulty as Difficulty)) {
    issues.push({ field: "difficulty", message: `must be one of ${DIFFICULTIES.join(", ")}` });
  }

  // prompts
  if (!Array.isArray(u.prompts) || u.prompts.length === 0) {
    issues.push({ field: "prompts", message: "must be a non-empty array" });
  } else {
    const seenPromptIds = new Set<string>();
    u.prompts.forEach((p, i) => {
      const field = `prompts[${i}]`;
      if (p === null || typeof p !== "object") {
        issues.push({ field, message: "must be an object" });
        return;
      }
      if (typeof p.id !== "string" || p.id.trim().length === 0) {
        issues.push({ field: `${field}.id`, message: "must be a non-empty string" });
      } else if (seenPromptIds.has(p.id)) {
        issues.push({ field: `${field}.id`, message: `duplicate prompt id "${p.id}" within the unit` });
      }
      seenPromptIds.add(p.id);
      if (typeof p.text !== "string" || p.text.trim().length === 0) {
        issues.push({ field: `${field}.text`, message: "must be a non-empty string" });
      }
    });
  }

  // measures
  if (!Array.isArray(u.measures) || u.measures.length === 0) {
    issues.push({ field: "measures", message: "must be a non-empty array" });
  } else {
    for (const m of u.measures) {
      if (!MEASURES.includes(m as Measure)) {
        issues.push({ field: "measures", message: `unknown measure "${String(m)}"` });
      }
    }
  }

  // applicable_roles
  if (!Array.isArray(u.applicable_roles) || u.applicable_roles.length === 0) {
    issues.push({ field: "applicable_roles", message: "must be a non-empty array" });
  } else {
    u.applicable_roles.forEach((r, i) => {
      if (typeof r !== "string" || r.trim().length === 0) {
        issues.push({ field: `applicable_roles[${i}]`, message: "must be a non-empty string" });
      }
    });
  }

  validateConfig(u.recommended_config, issues);

  validateScoring(u.scoring, issues);

  if (!UNIT_SOURCES.includes(u.source as UnitSource)) {
    issues.push({ field: "source", message: `must be one of ${UNIT_SOURCES.join(", ")}` });
  }

  if (!Number.isInteger(u.version) || (u.version as number) < 1) {
    issues.push({ field: "version", message: "must be a positive integer" });
  }

  return { ok: issues.length === 0, issues };
}

function validateConfig(config: unknown, issues: ValidationIssue[]): void {
  const c = config as TestUnit["recommended_config"] | null;
  if (c === null || typeof c !== "object") {
    issues.push({ field: "recommended_config", message: "must be an object" });
    return;
  }
  if (typeof c.context_length !== "number" || !Number.isFinite(c.context_length) || c.context_length < 128) {
    issues.push({ field: "recommended_config.context_length", message: "must be a number >= 128" });
  }
  if (!KV_CACHE_QUANTS.includes(c.kv_cache_quant as KvCacheQuant)) {
    issues.push({ field: "recommended_config.kv_cache_quant", message: `must be one of ${KV_CACHE_QUANTS.join(", ")}` });
  }
  if (typeof c.temperature !== "number" || !Number.isFinite(c.temperature) || c.temperature < 0 || c.temperature > 2) {
    issues.push({ field: "recommended_config.temperature", message: "must be a number in [0, 2]" });
  }
  if (typeof c.top_p !== "number" || !Number.isFinite(c.top_p) || c.top_p < 0 || c.top_p > 1) {
    issues.push({ field: "recommended_config.top_p", message: "must be a number in [0, 1]" });
  }
  if (!Number.isInteger(c.top_k) || (c.top_k as number) < 1) {
    issues.push({ field: "recommended_config.top_k", message: "must be an integer >= 1" });
  }
  if (typeof c.repeat_penalty !== "number" || !Number.isFinite(c.repeat_penalty) || c.repeat_penalty < 0.5 || c.repeat_penalty > 3) {
    issues.push({ field: "recommended_config.repeat_penalty", message: "must be a number in [0.5, 3]" });
  }
  if (!Number.isInteger(c.max_output_tokens) || (c.max_output_tokens as number) < 1) {
    issues.push({ field: "recommended_config.max_output_tokens", message: "must be a positive integer" });
  }
}

function validateScoring(scoring: unknown, issues: ValidationIssue[]): void {
  const s = scoring as ScoringSpec | null;
  if (s === null || typeof s !== "object") {
    issues.push({ field: "scoring", message: "must be an object" });
    return;
  }
  if (!SCORING_METHODS.includes(s.method as ScoringMethod)) {
    issues.push({ field: "scoring.method", message: `must be one of ${SCORING_METHODS.join(", ")}` });
    return;
  }
  if (s.method === "deterministic_rule") {
    const rule = s.rule;
    if (rule === null || typeof rule !== "object") {
      issues.push({ field: "scoring.rule", message: "required when method = deterministic_rule" });
      return;
    }
    if (!RULE_TYPES.includes(rule.type as RuleType)) {
      issues.push({ field: "scoring.rule.type", message: `must be one of ${RULE_TYPES.join(", ")}` });
      return;
    }
    const params = rule.params ?? {};
    switch (rule.type) {
      case "exact_match":
        if (typeof params.expected !== "string" || params.expected.length === 0) {
          issues.push({ field: "scoring.rule.params.expected", message: "required non-empty string for exact_match" });
        }
        break;
      case "label_in_set":
        if (!Array.isArray(params.set) || params.set.length === 0 || params.set.some((x) => typeof x !== "string")) {
          issues.push({ field: "scoring.rule.params.set", message: "required non-empty string array for label_in_set" });
        }
        break;
      case "regex_match":
        if (typeof params.pattern !== "string" || params.pattern.length === 0) {
          issues.push({ field: "scoring.rule.params.pattern", message: "required non-empty string for regex_match" });
        } else {
          try {
            new RegExp(params.pattern);
          } catch {
            issues.push({ field: "scoring.rule.params.pattern", message: "must be a valid regular expression" });
          }
        }
        break;
      case "json_valid":
        break; // no required params
    }
  } else {
    // orchestrator_judged
    if (typeof s.rubric !== "string" || s.rubric.trim().length < MIN_RUBRIC_CHARS) {
      issues.push({ field: "scoring.rubric", message: `required non-trivial rubric (>= ${MIN_RUBRIC_CHARS} chars) when method = orchestrator_judged` });
    }
  }
}
