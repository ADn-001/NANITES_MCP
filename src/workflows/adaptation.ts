/**
 * Use-case adaptation flow. The authoring of new test units is inference-heavy
 * and belongs to the companion skill; the deterministic part lives here: check
 * whether a profile's use case diverges from "nanites-default" (and surface the
 * prompt + default-plan notice), and register a batch of authored units through
 * validate -> register, rejecting anything that fails validation with its
 * issues surfaced — never silently dropping or force-registering.
 */
import type { ToolDeps } from "../tools/deps.js";
import type { TestUnit } from "../testunits/schema.js";
import { validateTestUnit } from "../testunits/validator.js";
import { DEFAULT_USE_CASE } from "../storage/profileDefaults.js";

export interface AdaptationCheckResult {
  use_case: string;
  needs_adaptation: boolean;
  prompt: string | null;
  default_plan_notice: string | null;
}

export interface RejectedUnit {
  name: string;
  id: string;
  issues: string[];
}

export interface AdaptationRegistrationResult {
  registered: number;
  rejected: RejectedUnit[];
}

export function checkAdaptation(useCase: string): AdaptationCheckResult {
  if (useCase === DEFAULT_USE_CASE) {
    return { use_case: useCase, needs_adaptation: false, prompt: null, default_plan_notice: null };
  }
  return {
    use_case: useCase,
    needs_adaptation: true,
    prompt: `Your profile's use case "${useCase}" differs from "nanites-default". The default test plan may not be well-calibrated for it. Do you want me to draft custom test units for this use case? (yes/no)`,
    default_plan_notice: `Using the default test plan may not be well-calibrated for use case "${useCase}".`,
  };
}

export function registerAdaptedUnits(deps: ToolDeps, profileName: string, units: TestUnit[]): AdaptationRegistrationResult {
  const rejected: RejectedUnit[] = [];
  const existingIds = deps.testUnits.list(profileName).map((u) => u.id);
  let registered = 0;

  for (const unit of units) {
    const { ok, issues } = validateTestUnit(unit, existingIds);
    if (!ok) {
      rejected.push({ name: unit.name ?? unit.id, id: unit.id ?? "unknown", issues: issues.map((i) => `${i.field}: ${i.message}`) });
      continue;
    }
    deps.testUnits.register(profileName, unit);
    existingIds.push(unit.id);
    registered++;
  }

  return { registered, rejected };
}
