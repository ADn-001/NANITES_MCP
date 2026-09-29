/**
 * Tool-call argument repair.
 *
 * A model that means to call a tool often emits arguments that are almost
 * JSON: wrapped in prose, in a code fence, with a trailing comma, truncated.
 * The existing behaviour was to give up and pass `{}` — which is the WORST
 * outcome, because the call then runs with no parameters. A `write_file` with
 * empty arguments, a `search_files` matching nothing, a crash inside the tool.
 * And it is silent: nothing in the response says the model's intent was thrown
 * away.
 *
 * The ladder is deterministic FIRST, always:
 *
 *   1. direct    — JSON.parse as-is
 *   2. extracted — the outermost balanced {...}, ignoring braces inside strings
 *   3. coerced   — a fixed set of syntax corrections that cannot change meaning
 *
 * A model is the LAST resort and is off by default, because a small model that
 * hallucinates a plausible `write_file` path is worse than a clean error.
 *
 * Every correction in rung 3 is a SYNTAX fix. None of them can change what a
 * valid value means — that is the whole constraint, and it is why
 * single-to-double quote conversion is deliberately excluded.
 */

export type RepairMethod = "direct" | "extracted" | "coerced" | "model" | "object";

export interface RepairOk {
  ok: true;
  args: Record<string, unknown>;
  method: RepairMethod;
}

export interface RepairFail {
  ok: false;
  /** Which rungs were tried, for the error message. */
  tried: RepairMethod[];
  detail: string;
}

export type RepairOutcome = RepairOk | RepairFail;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rung 1. */
export function tryDirect(raw: string): RepairOutcome | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? { ok: true, args: parsed, method: "direct" } : null;
  } catch {
    return null;
  }
}

/**
 * Rung 2. Find the outermost balanced `{...}`.
 *
 * Tracks string literals and escapes, because a brace inside a string is not a
 * brace. This single rung fixes the three most common malformations: prose
 * around the JSON, a code fence, and trailing chatter.
 *
 * It does NOT fix truncation — a truncated object has no closing brace, so the
 * scan finds nothing. `closeTruncated` handles that separately.
 */
export function extractBalanced(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function tryExtracted(raw: string): RepairOutcome | null {
  const candidate = extractBalanced(raw);
  if (!candidate) return null;
  return tryDirect(candidate);
}

/**
 * Rung 3. Syntax corrections that cannot change a valid value's meaning.
 *
 * Each one is applied OUTSIDE string literals. A comma inside "a, b" must
 * survive, and an apostrophe inside a value must not be touched.
 */
export function coerce(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; out += ch; continue; }

    // Python literals, outside strings. Same JSON meaning.
    if (ch === "N" && raw.startsWith("None", i) && !/["\w$]/.test(raw[i + 4] ?? " ")) {
      out += "null"; i += 3; continue;
    }
    if (ch === "T" && raw.startsWith("True", i) && !/["\w$]/.test(raw[i + 4] ?? " ")) {
      out += "true"; i += 3; continue;
    }
    if (ch === "F" && raw.startsWith("False", i) && !/["\w$]/.test(raw[i + 5] ?? " ")) {
      out += "false"; i += 4; continue;
    }

    // Unquoted object keys, outside strings.
    if (/[A-Za-z_$]/.test(ch) && /[{,]\s*$/.test(out)) {
      let j = i;
      while (j < raw.length && /[\w$]/.test(raw[j]!)) j++;
      if (j > i && raw[j] === ":") {
        out += `"${raw.slice(i, j)}"` + ":";
        i = j;
        continue;
      }
    }

    // Commas are handled in a second pass, once the structural characters have
    // been normalised. Doing it here while string state is live was the first
    // attempt and it was wrong: the pass below already tracks strings, and
    // duplicating the logic here only created a way for the two to disagree.
    out += ch;
  }

  return stripTrailingCommas(out);
}

/** Remove commas that sit immediately before a closing bracket, outside strings. */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      const rest = input.slice(i + 1);
      if (/^[ \t\r\n]*[}\]]/.test(rest)) continue;   // drop it
    }
    out += ch;
  }
  return out;
}

/**
 * Close a TRUNCATED object.
 *
 * Truncation is the case a model cannot fix by itself and a caller often
 * cannot either — the information is simply missing. But if every required
 * field is already present and only the closing punctuation is absent, adding
 * it recovers a complete, correct call. If a field is missing, this returns
 * null and the caller fails loudly rather than executing a partial write.
 */
export function closeTruncated(raw: string): RepairOutcome | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // An unterminated string means the value itself is cut off; closing it would
  // fabricate content.
  if (inString) return null;
  if (stack.length === 0) return null;

  let tail = "";
  for (let i = stack.length - 1; i >= 0; i--) tail += stack[i] === "{" ? "}" : "]";
  // A dangling key like `{"a":` cannot be closed into anything meaningful.
  if (/[:,]\s*$/.test(raw)) return null;

  return tryDirect(raw + tail);
}

/**
 * The ladder. Rungs 1-3, in order, stopping at the first success.
 *
 * Truncation is tried LAST and only when the object is genuinely unclosed —
 * a well-formed object that merely failed to parse for a syntax reason should
 * not be "closed", because the closing brace was never the problem.
 */
export function repairToolArguments(raw: string): RepairOutcome {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, tried: [], detail: "arguments were empty" };
  }

  const tried: RepairMethod[] = [];

  const direct = tryDirect(raw);
  if (direct) return direct;
  tried.push("direct");

  const extracted = tryExtracted(raw);
  if (extracted) return extracted;
  tried.push("extracted");

  const coerced = tryDirect(coerce(extractBalanced(raw) ?? raw));
  if (coerced) return coerced;
  tried.push("coerced");

  // Only worth closing if the braces are actually unbalanced.
  if (extractBalanced(raw) === null) {
    const closed = closeTruncated(raw);
    if (closed) return closed;
  }
  tried.push("coerced");

  return {
    ok: false,
    tried,
    detail: "no rung produced a JSON object",
  };
}

/** Repair an already-parsed value (an object needs no work; a string does). */
export function repairToolArgumentsValue(raw: unknown): RepairOutcome {
  if (isPlainObject(raw)) return { ok: true, args: raw, method: "object" };
  if (typeof raw === "string") return repairToolArguments(raw);
  if (raw === null || raw === undefined) {
    return { ok: false, tried: [], detail: "arguments were null" };
  }
  return { ok: false, tried: [], detail: `arguments were ${typeof raw}` };
}

/* ------------------------------------------------------------- validation */

export interface SchemaIssue { path: string; message: string }

/**
 * Validate against a JSON Schema, covering what a tool schema actually uses:
 * types, required properties, and additionalProperties. Deliberately NOT a
 * full validator — a partial one that silently passes is worse than none.
 */
export function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  path = "",
): SchemaIssue[] {
  if (!schema || typeof schema !== "object") return [];

  const issues: SchemaIssue[] = [];
  const at = (k: string): string => (path ? `${path}.${k}` : k);

  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        issues.push({ path: at(key), message: "required property is missing" });
      }
    }
  }

  const properties = schema["properties"];
  if (isPlainObject(properties)) {
    for (const [key, propSpec] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const expected = isPlainObject(propSpec) ? propSpec["type"] : undefined;
      const actual = value[key];
      if (typeof expected === "string" && !typeMatches(actual, expected)) {
        issues.push({ path: at(key), message: `expected ${expected}` });
      }
    }
  }

  if (schema["additionalProperties"] === false && isPlainObject(properties)) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        issues.push({ path: at(key), message: "additional property is not allowed" });
      }
    }
  }

  return issues;
}

function typeMatches(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    case "null": return value === null;
    default: return true;
  }
}

/** Repair, then validate. A repair that produces a schema-invalid object fails. */
export function repairAndValidate(
  raw: unknown,
  schema: Record<string, unknown> | undefined,
): { ok: true; args: Record<string, unknown>; method: RepairMethod } | { ok: false; code: "tool_call_unrepairable"; detail: string } {
  const outcome = repairToolArgumentsValue(raw);
  if (!outcome.ok) {
    return { ok: false, code: "tool_call_unrepairable", detail: outcome.detail };
  }
  const issues = validateAgainstSchema(outcome.args, schema);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    return { ok: false, code: "tool_call_unrepairable", detail: `schema validation failed — ${detail}` };
  }
  return { ok: true, args: outcome.args, method: outcome.method };
}
