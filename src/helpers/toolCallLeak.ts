/**
 * Leaked tool calls. A cloud model that has been given function
 * schemas sometimes does not use the API's `tool_calls` field: it writes the
 * call into `content` in whatever dialect its chat template trained it on,
 * returns `finish_reason: "stop"`, and the loop — which accepts any non-empty
 * content as the answer — hands that markup back as the reply. The run reports
 * `done` and the delegation produced nothing.
 *
 * Two dialects are real, both observed (a role-by-role probe, plus the leaked
 * jobs):
 *
 *   - `harmony` (gpt-oss-120b/20b on Cloudflare), seen live:
 *     `analysis: need to read file.<|end|><|start|>assistantcommentary to=functions.read_file {"path":" src/providers/fsTools.ts"," limit":4000}<|call|>`
 *     Canonically `<|start|>assistant<|channel|>commentary to=functions.NAME<|constrain|>json<|message|>{...}<|call|>`;
 *     gpt-oss also flattens the channel token out, so only `to=functions.NAME`
 *     and the closing `<|call|>` are reliable.
 *   - `tool_call` (Hermes/Qwen-family templates, the samples from
 *     `glm-4.7-flash` jobs): `<tool_call>{"name":..,"arguments":{..}}</tool_call>`,
 *     or the tag-attribute form with `<function=..>` / `<parameter=..>` /
 *     `<arg_key>`/`<arg_value>` pairs.
 *
 * Parsing is deliberately strict. `null` means "this is a leaked call and I
 * cannot trust any reading of it", which the callers turn into a structured
 * error — never into an answer. The samples include an unbalanced one
 * (two `arg_key`, one `arg_value`), and half-parsed arguments executed against
 * the filesystem would be worse than a loud failure.
 */
import type { ChatToolCall } from "../providers/types.js";

export type LeakDialect = "harmony" | "tool_call";

const HARMONY_NAME = /to=functions\.([A-Za-z_][\w.-]*)/g;
const HARMONY_END = /<\|call\|>|<\|start\|>/;

/** Structural marker only — says "a call is in here", not "it parses". */
export function looksLikeLeakedToolCall(text: string): boolean {
  if (!text) return false;
  if (text.includes("<tool_call>")) return true;
  return text.includes("to=functions.") && text.includes("<|call|>");
}

/** The dialect a leak is written in, or null when there is no leak. */
export function leakedToolCallDialect(text: string): LeakDialect | null {
  if (!text) return null;
  if (text.includes("to=functions.") && text.includes("<|call|>")) return "harmony";
  if (text.includes("<tool_call>")) return "tool_call";
  return null;
}

/**
 * Strict parse of every leaked call in `text`. Returns null when the dialect is
 * recognizable but any part of a call is missing, unbalanced, or not JSON where
 * JSON is required.
 */
export function parseLeakedToolCalls(text: string): ChatToolCall[] | null {
  const dialect = leakedToolCallDialect(text ?? "");
  if (dialect === "harmony") return parseHarmony(text);
  if (dialect === "tool_call") return parseToolCallBlocks(text);
  return null;
}

/** Slice a complete JSON object starting at `from` (which must be "{"); null if unbalanced. */
function scanJsonObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

function parseArgsJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseHarmony(text: string): ChatToolCall[] | null {
  const calls: ChatToolCall[] = [];
  HARMONY_NAME.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HARMONY_NAME.exec(text)) !== null) {
    const name = match[1]!;
    const tail = text.slice(match.index);
    const stop = tail.search(HARMONY_END);
    if (stop === -1) return null; // no terminator: not a call we can trust
    const region = tail.slice(0, stop);
    const braceAt = region.indexOf("{");
    if (braceAt === -1) return null;
    const json = scanJsonObject(region, braceAt);
    if (!json) return null;
    const args = parseArgsJson(json);
    if (!args) return null;
    calls.push({ id: `call_leak_${calls.length + 1}`, name, arguments: args });
  }
  return calls.length > 0 ? calls : null;
}

function parseToolCallBlocks(text: string): ChatToolCall[] | null {
  const blocks = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map((m) => m[1]!);
  // An unterminated `<tool_call>` is a leak we cannot parse either.
  if (blocks.length === 0) return null;
  const calls: ChatToolCall[] = [];
  for (const block of blocks) {
    const call = parseToolCallBlock(block);
    if (!call) return null;
    calls.push({ ...call, id: `call_leak_${calls.length + 1}` });
  }
  return calls;
}

function parseToolCallBlock(block: string): Omit<ChatToolCall, "id"> | null {
  // 1. JSON body: {"name":..,"arguments":{..}} (occasionally nested under "function").
  const braceAt = block.indexOf("{");
  if (braceAt !== -1) {
    const json = scanJsonObject(block, braceAt);
    const parsed = json ? parseArgsJson(json) : null;
    if (parsed) {
      const fn = parsed.function && typeof parsed.function === "object" ? (parsed.function as Record<string, unknown>) : null;
      const name = typeof parsed.name === "string" ? parsed.name : typeof fn?.name === "string" ? fn.name : null;
      const rawArgs = parsed.arguments ?? parsed.parameters ?? fn?.arguments;
      const args =
        typeof rawArgs === "string" ? parseArgsJson(rawArgs) : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : null;
      if (name && args) return { name, arguments: args };
      // Named but unreadable arguments: a leak we must not execute.
      if (name) return null;
      // No name in the JSON — fall through to the tag/bare forms.
    }
  }

  // 2. Tag-attribute body: <function=name> with <parameter=key>value</parameter>
  //    or <arg_key>key</arg_key><arg_value>value</arg_value> children.
  const fnMatch = block.match(/<function=([A-Za-z_][\w.-]*)\s*>/);
  const params = [...block.matchAll(/<parameter=([A-Za-z_][\w.-]*)>([\s\S]*?)<\/parameter>/g)];
  const keys = [...block.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>/g)].map((m) => m[1]!.trim());
  const values = [...block.matchAll(/<arg_value>([\s\S]*?)<\/arg_value>/g)].map((m) => m[1]!.trim());
  if (fnMatch) {
    if (params.length > 0) {
      const args: Record<string, unknown> = {};
      for (const p of params) args[p[1]!] = coerceValue(p[2]!.trim());
      return { name: fnMatch[1]!, arguments: args };
    }
    // Unbalanced key/value counts are the malformed-sample case: refuse the
    // whole call rather than execute half an argument list.
    if (keys.length !== values.length || keys.length === 0) return null;
    const args: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      args[k] = coerceValue(values[i]!);
    });
    return { name: fnMatch[1]!, arguments: args };
  }
  // Arg tags with no function name anywhere: nothing to execute, so not a call.
  if (keys.length > 0 || values.length > 0 || params.length > 0) return null;

  // 3. Bare call: name({...})
  const bare = block.match(/([A-Za-z_][\w.-]*)\s*\(\s*(\{[\s\S]*\})\s*\)/);
  if (bare) {
    const json = scanJsonObject(bare[2]!, 0);
    const args = json ? parseArgsJson(json) : null;
    if (args) return { name: bare[1]!, arguments: args };
  }
  return null;
}

/** Template arguments are strings; keep JSON scalars where the model meant one. */
function coerceValue(raw: string): unknown {
  if (raw === "") return "";
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
