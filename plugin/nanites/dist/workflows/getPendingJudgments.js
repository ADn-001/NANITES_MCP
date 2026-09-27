/**
 * Judgment surface for orchestrator-judged units. Returns the cleaned raw
 * output plus rubric/prompt context for the orchestrator to read and judge in
 * that same turn — for only the units explicitly requested, never the whole
 * regimen. A requested unit that is not pending is a caller error.
 */
import { NanitesError } from "../helpers/errors.js";
export function getPendingJudgments(deps, profileName, modelId, unitIds) {
    const pending = deps.testResults.listPending(profileName, modelId);
    // No subset requested -> null, not an empty Set (an empty Set is truthy and
    // would filter everything out).
    const wanted = unitIds && unitIds.length > 0 ? new Set(unitIds) : null;
    if (unitIds && unitIds.length > 0) {
        const pendingIds = new Set(pending.map((r) => r.unit_id));
        const missing = unitIds.filter((id) => !pendingIds.has(id));
        if (missing.length > 0) {
            throw new NanitesError({
                code: "test_unit_not_pending",
                message: `Unit(s) are not pending judgment: ${missing.join(", ")}`,
                retryable: false,
            });
        }
    }
    const out = [];
    for (const result of pending) {
        if (wanted && !wanted.has(result.unit_id))
            continue;
        const unit = deps.testUnits.get(profileName, result.unit_id);
        out.push({
            unit_id: result.unit_id,
            unit_name: unit?.name ?? result.unit_id,
            task_group: unit?.task_group ?? "unknown",
            rubric: unit?.scoring.rubric ?? null,
            prompt_texts: unit?.prompts.map((p) => p.text) ?? [],
            raw_output: result.raw_output ?? "",
        });
    }
    return { pending: out };
}
