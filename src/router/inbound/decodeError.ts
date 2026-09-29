/**
 * Decode failures.
 *
 * A decoder is a pure function over untrusted JSON, so its only failure mode is
 * a caller mistake — and a caller mistake must produce a message naming the
 * FIELD, not a stack trace and not a generic "bad request". The path is
 * threaded through so "messages[2].content[0].type is required" is possible.
 */
import { NanitesError } from "../../helpers/errors.js";

export function decodeError(path: string, detail: string): NanitesError {
  return new NanitesError({
    code: "router_invalid_request",
    message: `${path}: ${detail}`,
    retryable: false,
    details: { path },
  });
}

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw decodeError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw decodeError(path, "expected an array");
  return value;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw decodeError(path, "expected a string");
  return value;
}

export function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, path);
}

export function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw decodeError(path, "expected a finite number");
  }
  return value;
}

export function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw decodeError(path, "expected a boolean");
  return value;
}

/** A finite number within an inclusive range, or undefined when absent. */
export function boundedNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined {
  const n = optionalNumber(value, path);
  if (n === undefined) return undefined;
  if (n < min || n > max) throw decodeError(path, `must be between ${min} and ${max}`);
  return n;
}
