/**
 * Tool response envelope. Every tool returns a single JSON text block:
 *   success -> { ok: true, data: <result> }
 *   failure -> { ok: false, error: { code, message, retryable, details? } }
 * Errors are always the structured Nanites shape — never a raw throw, stack
 * trace, or HTTP body reaching the orchestrator.
 */
import { NanitesError, type NanitesErrorShape } from "../helpers/errors.js";

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

export function ok(data: unknown): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
}

export function fail(error: unknown): ToolCallResult {
  const shape: NanitesErrorShape =
    error instanceof NanitesError
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
export async function guard<T>(handler: () => Promise<T> | T): Promise<ToolCallResult> {
  try {
    return ok(await handler());
  } catch (error) {
    return fail(error);
  }
}
