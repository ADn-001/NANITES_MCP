/**
 * Consume a provider's SSE stream and assemble it into IR pieces.
 *
 * The existing `ProviderClient.streamChat` is NOT reused here, for a concrete
 * reason: its per-provider loops (client.ts) drop two things the router needs.
 * They never capture `usage` from the stream, and they never read
 * `delta.tool_calls` at all — so a tool call streams by and arrives as
 * nothing. `reassembleStream` (client.ts:257) does read usage, but it is dead
 * code and has never been run against real provider output, so trusting it
 * unverified would repeat the mistake it was written to prevent.
 *
 * This assembler reads what the Anthropic Messages contract actually requires:
 * text deltas, thinking deltas, and TOOL-CALL ARGUMENT FRAGMENTS kept as
 * fragments. A partial JSON fragment is not valid JSON and must not be parsed
 * mid-stream — that is the single most common way to corrupt a tool call.
 */
import type { IRToolCall, IRUsage } from "../ir/types.js";

export type UpstreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "signature"; delta: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; args_fragment: string }
  | { type: "usage"; usage: IRUsage }
  | { type: "finish"; finish_reason: string }
  | { type: "error"; message: string };

export interface Assembled {
  content: string;
  thinking: string;
  signature: string;
  toolCalls: IRToolCall[];
  finish_reason: string;
  usage: IRUsage;
}

/** Tolerate the several shapes providers use for a reasoning delta. */
function reasoningOf(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) {
    const joined = value
      .map((v) => (typeof v === "string" ? v : String((v as { content?: unknown })?.content ?? "")))
      .join("");
    return joined || undefined;
  }
  return undefined;
}

function toUsage(raw: unknown): IRUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const prompt = u["prompt_tokens"] ?? u["input_tokens"];
  const completion = u["completion_tokens"] ?? u["output_tokens"];
  if (typeof prompt !== "number" || typeof completion !== "number") return null;
  const details = u["completion_tokens_details"] as { reasoning_tokens?: number } | undefined;
  return {
    input_tokens: prompt,
    output_tokens: completion,
    ...(typeof details?.reasoning_tokens === "number" ? { reasoning_tokens: details.reasoning_tokens } : {}),
  };
}

/**
 * Fold one SSE payload into the accumulator and yield the events it implies.
 * Split out from the reader so the state machine is testable on raw strings,
 * with no ReadableStream in the way.
 */
export function foldChunk(assembly: MutableAssembly, raw: string): UpstreamEvent[] {
  const events: UpstreamEvent[] = [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[DONE]") return events;

  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    // A malformed frame is skipped, exactly as every existing provider loop
    // does. Dropping one delta is better than failing the whole stream.
    return events;
  }

  const usage = toUsage(frame["usage"]);
  if (usage) {
    assembly.usage = usage;
    events.push({ type: "usage", usage });
  }

  const choices = frame["choices"] as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  if (!choice) return events;

  const delta = choice["delta"] as Record<string, unknown> | undefined;

  if (delta) {
    if (typeof delta["content"] === "string" && delta["content"]) {
      assembly.content += delta["content"];
      events.push({ type: "text", delta: delta["content"] });
    }

    const reasoning =
      reasoningOf(delta["reasoning"]) ?? reasoningOf(delta["reasoning_content"]);
    if (reasoning) {
      assembly.thinking += reasoning;
      events.push({ type: "thinking", delta: reasoning });
    }

    // Anthropic-compatible gateways stream a signed thinking block as a
    // separate signature_delta, which the IR must round-trip.
    const sig = delta["signature"];
    if (typeof sig === "string" && sig) {
      assembly.signature = sig;
      events.push({ type: "signature", delta: sig });
    }

    const calls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(calls)) {
      for (const [position, call] of calls.entries()) {
        const index = typeof call["index"] === "number" ? (call["index"] as number) : position;
        const fn = call["function"] as Record<string, unknown> | undefined;

        if (typeof call["id"] === "string" && call["id"]) {
          assembly.toolCalls[index] = {
            id: call["id"],
            name: typeof fn?.["name"] === "string" ? (fn["name"] as string) : "",
            arguments: {},
          };
          events.push({ type: "tool_start", index, id: call["id"], name: String(fn?.["name"] ?? "") });
        }

        if (fn && typeof fn["arguments"] === "string" && fn["arguments"] !== "") {
          // Fragment kept VERBATIM. Parsing here is the bug this whole
          // comment exists to prevent.
          assembly.argFragments[index] = (assembly.argFragments[index] ?? "") + (fn["arguments"] as string);
          events.push({ type: "tool_delta", index, args_fragment: fn["arguments"] as string });
        }
      }
    }
  }

  const finish = choice["finish_reason"];
  if (typeof finish === "string" && finish) {
    assembly.finish_reason = finish;
    events.push({ type: "finish", finish_reason: finish });
  }

  return events;
}

export interface MutableAssembly {
  content: string;
  thinking: string;
  signature: string;
  /** index -> tool call, id and name filled as they arrive. */
  toolCalls: Array<IRToolCall | undefined>;
  /** index -> concatenated raw argument JSON, assembled but NOT parsed. */
  argFragments: Array<string | undefined>;
  finish_reason: string;
  usage: IRUsage;
}

export function newAssembly(): MutableAssembly {
  return {
    content: "",
    thinking: "",
    signature: "",
    toolCalls: [],
    argFragments: [],
    finish_reason: "",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

export function finalizeAssembly(state: MutableAssembly): Assembled {
  const toolCalls: IRToolCall[] = [];
  for (let i = 0; i < state.toolCalls.length; i++) {
    const call = state.toolCalls[i];
    if (!call) continue;
    const fragment = state.argFragments[i];
    // The raw fragment is exposed alongside the parsed value so the R6 repair
    // ladder can run on it. If it does not parse, `arguments` is {} here —
    // which is exactly the state R6 exists to prevent reaching a tool, so R6
    // replaces this with the repair ladder before anything executes.
    let parsed: Record<string, unknown> = {};
    if (fragment) {
      try {
        const value: unknown = JSON.parse(fragment);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        parsed = {};
      }
    }
    toolCalls.push({ id: call.id, name: call.name, arguments: parsed });
  }

  return {
    content: state.content,
    thinking: state.thinking,
    signature: state.signature,
    toolCalls,
    finish_reason: state.finish_reason,
    usage: state.usage,
  };
}
