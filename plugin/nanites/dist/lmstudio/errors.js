import { NanitesError } from "../helpers/errors.js";
export const LmErrorCodes = {
    CONNECTION_REFUSED: "connection_refused",
    NETWORK_ERROR: "network_error",
    TIMEOUT: "timeout",
    HTTP_4XX: "http_client_error",
    HTTP_5XX: "http_server_error",
    MALFORMED_JSON: "malformed_json",
    TRUNCATED_STREAM: "truncated_stream",
    /** A streaming generation stalled — zero new tokens for the idle window. */
    IDLE_TIMEOUT: "generation_idle_timeout",
    /** A blocking model load stalled — the endpoint stopped answering heartbeats. */
    LOAD_IDLE_TIMEOUT: "load_idle_timeout",
};
export function isTimeoutError(err) {
    return err instanceof Error && err.name === "TimeoutError";
}
/** Node's fetch wraps ECONNREFUSED inside a cause chain; dig it out. */
export function hasConnRefused(err) {
    let current = err;
    for (let depth = 0; depth < 4; depth++) {
        if (current instanceof AggregateError && current.errors.length > 0) {
            current = current.errors[0];
            continue;
        }
        if (current instanceof Error) {
            if (current.code === "ECONNREFUSED")
                return true;
            current = current.cause;
            continue;
        }
        break;
    }
    return false;
}
export function mapFetchError(err) {
    if (isTimeoutError(err)) {
        return new NanitesError({ code: LmErrorCodes.TIMEOUT, message: "LM Studio request timed out", retryable: true });
    }
    if (hasConnRefused(err)) {
        return new NanitesError({
            code: LmErrorCodes.CONNECTION_REFUSED,
            message: "LM Studio server unreachable (connection refused)",
            retryable: true,
        });
    }
    return new NanitesError({ code: LmErrorCodes.NETWORK_ERROR, message: "LM Studio network error", retryable: true });
}
/**
 * A short, path-free summary of an upstream error body.
 *
 * Parses the common JSON error shapes and keeps only a short message.
 * Anything else is reported by kind alone, with no content: an HTML error
 * page is exactly the case that leaks paths.
 */
function summarizeBody(body) {
    if (!body)
        return "";
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object") {
            const rec = parsed;
            for (const key of ["error", "message", "detail", "title"]) {
                const v = rec[key];
                if (typeof v === "string" && v)
                    return v.slice(0, 200);
                if (v && typeof v === "object") {
                    const inner = v.message;
                    if (typeof inner === "string" && inner)
                        return inner.slice(0, 200);
                }
            }
        }
    }
    catch {
        // Not JSON — an HTML error page or a stack trace. Report no content.
    }
    return "[non-JSON error body omitted]";
}
export function mapHttpStatus(status, body) {
    const is4xx = status >= 400 && status < 500;
    const is5xx = status >= 500 && status < 600;
    return new NanitesError({
        code: is5xx ? LmErrorCodes.HTTP_5XX : LmErrorCodes.HTTP_4XX,
        message: `LM Studio returned HTTP ${status}`,
        retryable: is5xx,
        // Never ship the raw body. LM Studio error pages are HTML and stack
        // traces that carry absolute model paths and usernames, which CLAUDE.md
        // section 6 forbids in anything returned to the orchestrator. The cloud
        // path (src/providers/errors.ts) already parses and extracts a capped
        // message; this predates that convention and was never migrated.
        details: { status, body: summarizeBody(body) },
    });
}
export function malformedJsonError(bodySnippet) {
    return new NanitesError({
        code: LmErrorCodes.MALFORMED_JSON,
        message: "LM Studio returned malformed JSON",
        retryable: false,
        details: { body: summarizeBody(bodySnippet) },
    });
}
export function truncatedStreamError() {
    return new NanitesError({
        code: LmErrorCodes.TRUNCATED_STREAM,
        message: "LM Studio stream ended before chat.end",
        retryable: true,
    });
}
