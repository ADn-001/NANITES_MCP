/**
 * Tool response envelope. Every tool returns a single JSON text block:
 *   success -> { ok: true, data: <result> }
 *   failure -> { ok: false, error: { code, message, retryable, details? } }
 * Errors are always the structured Nanites shape — never a raw throw, stack
 * trace, or HTTP body reaching the orchestrator.
 */
import { NanitesError } from "../helpers/errors.js";
export function ok(data) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
}
export function fail(error) {
    const shape = error instanceof NanitesError
        ? error.toShape()
        : {
            code: "unexpected_error",
            // Never the raw message: better-sqlite3 and fs errors embed
            // absolute paths and machine names, and CLAUDE.md section 6
            // forbids those reaching the orchestrator. The real
            // text belongs in the server log.
            message: "Internal error",
            retryable: false,
        };
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: shape }) }] };
}
/** Run a handler and coerce any outcome into the envelope. */
export async function guard(handler) {
    try {
        return ok(await handler());
    }
    catch (error) {
        return fail(error);
    }
}
