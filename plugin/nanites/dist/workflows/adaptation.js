import { validateTestUnit } from "../testunits/validator.js";
import { DEFAULT_USE_CASE } from "../storage/profileDefaults.js";
export function checkAdaptation(useCase) {
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
export function registerAdaptedUnits(deps, profileName, units) {
    const rejected = [];
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
