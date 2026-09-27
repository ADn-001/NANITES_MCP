/**
 * Structured output.
 *
 * The nested OpenAI shape (`{type:"json_schema", json_schema:{name, schema}}`)
 * is the one every provider here accepts — including Cloudflare, whose
 * documentation describes a *flat* form (`{type:"json_schema", schema}`).
 * Measured live on 2026-09-10 (`scripts/cf-d1-shape-probe.ts`, same prompt,
 * same model, two accounts): flat returns **HTTP 500 with provider code 3043**
 * every time, while nested returns the schema-shaped answer and the identical
 * call with no `response_format` at all succeeds. The docs are wrong about the
 * endpoint this code actually calls, so the evidence wins. Keep the shape in
 * one place: a second mapping site is how the flat form got in.
 *
 * Because a rejected shape surfaces as a generic 500 rather than "bad
 * parameter", the answer is validated afterwards rather than trusted
 * (`parseStructured`), and the loop flags a non-conforming reply instead of
 * passing prose off as JSON.
 *
 * Validation is deliberately shallow: top-level type, plus the `required` keys
 * of a top-level object. A deep JSON Schema engine would be a dependency and a
 * false-positive source; when the provider honours the field it already
 * enforces the nested structure, and this layer only has to answer "did the
 * model ignore us?".
 */
import type { ProviderKind } from "../storage/profileDefaults.js";
import type { ResponseFormat } from "./types.js";

export interface StructuredCheck {
  ok: boolean;
  /** Parsed value when the text parsed — present even when `ok` is false, so a
   * caller can salvage a partially-conforming answer. */
  value?: unknown;
  problems: string[];
}

/** The single mapping from Nanites' intent to a provider's wire field. */
export function responseFormatFor(
  _provider: ProviderKind,
  format: ResponseFormat,
  name = "nanites_output",
): Record<string, unknown> {
  if (format.type === "json_object") return { type: "json_object" };
  return { type: "json_schema", json_schema: { name: format.name ?? name, schema: format.schema } };
}

/**
 * Strip a ```json fence, and — when the whole text is not JSON — fall back to
 * the span between the first `{` and the last `}`. Models leak prose around a
 * perfectly good JSON object; refusing that answer would throw away real work.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  const body = (fenced ? fenced[1]! : trimmed).trim();
  if (body.startsWith("{") || body.startsWith("[")) return body;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first !== -1 && last > first) return body.slice(first, last + 1);
  return body;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** Shallow conformance check: top-level type + required keys of an object. */
function checkShape(value: unknown, schema: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const type = schema.type;
  if (type === "object") {
    const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
    if (!isObject) {
      problems.push(`top-level value is ${describeValue(value)}, schema wants an object`);
      return problems;
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in (value as Record<string, unknown>))) {
        problems.push(`missing required key "${key}"`);
      }
    }
    return problems;
  }
  if (type === "array" && !Array.isArray(value)) {
    problems.push(`top-level value is ${describeValue(value)}, schema wants an array`);
  }
  return problems;
}

/** Parse a reply against a schema. Never throws — a non-conforming answer is a
 * result, not an exception. */
export function parseStructured(text: string, schema: Record<string, unknown>): StructuredCheck {
  const body = extractJson(text);
  if (!body) return { ok: false, problems: ["reply was empty"] };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    return { ok: false, problems: [`not valid JSON: ${(err as Error).message}`] };
  }
  const problems = checkShape(value, schema);
  return problems.length === 0 ? { ok: true, value, problems: [] } : { ok: false, value, problems };
}
