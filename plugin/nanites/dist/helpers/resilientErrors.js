/**
 * Resilient error handler. Maps any failure into a structured error plus a
 * documented recovery policy, so callers can act (or surface guidance)
 * instead of guessing.
 */
import { NanitesError } from "./errors.js";
import { LmErrorCodes } from "../lmstudio/errors.js";
export const RECOVERY_POLICIES = {
    unreachable: {
        mode: "unreachable",
        errorCode: LmErrorCodes.CONNECTION_REFUSED,
        retryable: true,
        recovery: "Attempt `lms server start`, wait, recheck once; if still down, abort the workflow with a clear message.",
        escalate: false,
    },
    model_load_failure: {
        mode: "model_load_failure",
        errorCode: LmErrorCodes.HTTP_5XX,
        retryable: true,
        recovery: "Unload any partial instance, retry with a smaller context_length or lower quantization; if it recurs, skip this model.",
        escalate: false,
    },
    midcall_disconnect: {
        mode: "midcall_disconnect",
        errorCode: LmErrorCodes.TRUNCATED_STREAM,
        retryable: true,
        recovery: "Retry with a shorter timeout; confirm the model is still loaded before rerunning.",
        escalate: false,
    },
    stalled_download: {
        mode: "stalled_download",
        errorCode: "stalled_download",
        retryable: true,
        recovery: "Wait and poll once more with backoff; if still stalled, surface a pause for the user to inspect.",
        escalate: false,
    },
    failed_download: {
        mode: "failed_download",
        errorCode: "failed_download",
        retryable: false,
        recovery: "Surface the error; user can retry the download. Check disk space first.",
        escalate: true,
    },
};
/**
 * Classify a thrown error (or a raw status object) into a structured
 * NanitesError + recovery policy. Always returns, never throws.
 */
export function handleFailure(err, status) {
    if (err instanceof NanitesError) {
        const mode = modeForCode(err.code);
        const policy = RECOVERY_POLICIES[mode];
        return { error: err, policy };
    }
    if (status?.status === "stalled") {
        return { error: stallError(), policy: RECOVERY_POLICIES.stalled_download };
    }
    if (status?.status === "failed") {
        return { error: new NanitesError({ code: "failed_download", message: "Model download failed", retryable: false }), policy: RECOVERY_POLICIES.failed_download };
    }
    const wrapped = new NanitesError({ code: "unexpected_error", message: err instanceof Error ? err.message : String(err), retryable: false });
    return { error: wrapped, policy: RECOVERY_POLICIES.failed_download };
}
function stallError() {
    return new NanitesError({ code: "stalled_download", message: "Download stalled with no progress", retryable: true });
}
function modeForCode(code) {
    switch (code) {
        case LmErrorCodes.CONNECTION_REFUSED:
        case LmErrorCodes.NETWORK_ERROR:
        case LmErrorCodes.TIMEOUT:
            return "unreachable";
        case LmErrorCodes.HTTP_5XX:
            return "model_load_failure";
        case LmErrorCodes.TRUNCATED_STREAM:
        case LmErrorCodes.MALFORMED_JSON:
            return "midcall_disconnect";
        case "stalled_download":
            return "stalled_download";
        case "failed_download":
            return "failed_download";
        default:
            return "failed_download";
    }
}
