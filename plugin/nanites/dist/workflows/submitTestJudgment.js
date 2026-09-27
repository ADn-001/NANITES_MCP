/**
 * Judgment submission for one orchestrator-judged unit under serial judging
 * (E4). The pending row is one candidate (baseline first, then its promoted
 * variant). Nothing becomes final in the registry until user_approved is true;
 * a submission with user_approved: false records the judgment (status
 * "judged") but keeps that candidate's score out of the registry.
 *
 * Per submission: (a) an approved judged candidate is logged to the param
 * search with its real score and the candidate's actual params (D10 — the
 * score is unknown at run time), continuing the attempt counter; (b) judging
 * the baseline promotes its staged variant sibling to pending for the second
 * pass; (c) only when no pending rows remain and a score is approved does
 * finalize write the role-keyed entry.
 */
import { NanitesError } from "../helpers/errors.js";
import { finalizeIfComplete } from "./finalize.js";
import { paramsForCandidate } from "../testunits/candidateParams.js";
export function submitTestJudgment(deps, input) {
    const existing = deps.testResults.get(input.profile, input.model_id, input.unit_id);
    if (!existing) {
        throw new NanitesError({
            code: "test_result_not_found",
            message: `No test result for unit "${input.unit_id}" on model "${input.model_id}"`,
            retryable: false,
        });
    }
    if (existing.status !== "pending") {
        throw new NanitesError({
            code: "test_result_not_pending",
            message: `Unit "${input.unit_id}" is not pending judgment (status: ${existing.status})`,
            retryable: false,
        });
    }
    const candidate = existing.candidate ?? "baseline";
    deps.testResults.submitJudgment(input.profile, input.model_id, input.unit_id, {
        score: input.score,
        orchestrator_notes: input.orchestrator_notes,
        user_approved: input.user_approved,
        user_notes: input.user_notes ?? null,
    });
    // D10: the judged candidate's real score exists now. Log it with the exact
    // params that candidate ran under so bestParamsFromAttempts can prefer the
    // higher-scoring (approved) candidate. A user_approved:false submission keeps
    // that candidate's config out of the search — best_params must never prefer a
    // config whose output the user rejected.
    if (input.user_approved) {
        const unit = deps.testUnits.get(input.profile, input.unit_id);
        if (unit) {
            deps.paramSearch.log({
                profile_name: input.profile,
                model_id: input.model_id,
                attempt: deps.paramSearch.nextAttempt(input.profile, input.model_id),
                params: paramsForCandidate(unit.recommended_config, candidate),
                score: input.score,
                detail: `orchestrator_judged:${candidate}`,
                unit_id: input.unit_id,
                candidate,
            });
        }
    }
    // Judging the baseline promotes its staged variant to pending so the next
    // get_pending_judgments pass sees it (serial judging).
    if (candidate === "baseline") {
        deps.testResults.promoteStaged(input.profile, input.model_id, input.unit_id);
    }
    const registered_entry = finalizeIfComplete(deps, input.profile, input.model_id);
    return { unit_id: input.unit_id, status: input.user_approved ? "approved" : "judged", registered_entry };
}
