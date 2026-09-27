/**
 * Health gate for multi-step workflows. Workflows #1/#2/#4 call this BEFORE
 * doing anything else; a `down` verdict aborts the workflow with a clear
 * structured error instead of wasting work discovering a dead endpoint mid-run.
 */
import { NanitesError } from "../helpers/errors.js";
import { clientForProfile } from "../tools/deps.js";
import { runHealthCheck } from "../health/checker.js";
export async function ensureHealthy(profileName, deps, opts = {}) {
    const profile = deps.profiles.getProfile(profileName);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
    }
    const report = await runHealthCheck({
        profile: profileName,
        client: clientForProfile(profile, { timeoutMs: 5_000 }),
        ...(opts.recovery ? { recovery: opts.recovery } : {}),
    });
    if (report.overall === "down") {
        throw new NanitesError({
            code: "health_check_failed",
            message: `Aborting workflow: ${report.reason}`,
            retryable: true,
            details: { overall: report.overall, reason: report.reason },
        });
    }
    return report;
}
