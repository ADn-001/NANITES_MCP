/**
 * Anthropic Messages <-> IR.
 *
 * Pure functions: body in, IR out and back. No store access, no provider
 * knowledge, no I/O — which is the only sane way to get real coverage on
 * translation code.
 *
 * Field mapping, complete. Every field of the Anthropic request shape appears
 * here, including the ones with no IR counterpart, which are DROPPED WITH A
 * RECORDED REASON. An unmapped field discovered later is a surprise; a mapped
 * one is a decision.
 *
 *   system (string|blocks)  -> IRRequest.system          (blocks concatenated)
 *   messages[].content[]    -> IRMessage.content
 *     {type:"text"}          -> {type:"text"}
 *     {type:"image",source}  -> {type:"image_url",url:"data:..."}
 *     {type:"thinking"}      -> IRMessage.thinking
 *     {type:"tool_use"}      -> IRMessage.tool_calls[]
 *     {type:"tool_result"}   -> a SEPARATE {role:"tool"} message
 *   tools[].input_schema    -> IRToolDef.input_schema
 *   max_tokens              -> IRRequest.max_output_tokens   (REQUIRED here)
 *   stop_sequences          -> IRRequest.stop
 *   stream                  -> IRRequest.stream
 *   temperature/top_p       -> carried
 *   model                   -> IRRequest.model
 *
 * Dropped, and why:
 *   metadata.user_id        -> routing/billing hint; no IR use
 *   service_tier            -> OpenRouter-only; meaningless elsewhere
 *   top_k / frequency_penalty / presence_penalty
 *                            -> not in the Messages API; accepted-and-ignored
 *                               upstream, so decoding them is pointless
 */
import {
  asArray,
  asRecord,
  asString,
  decodeError,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from "./decodeError.js";
import { repairAndValidate } from "../../helpers/toolCallRepair.js";
import type {
  IRContentPart,
  IRMessage,
  IRRequest,
  IRResponse,
  IRStopReason,
  IRThinkingBlock,
  IRToolCall,
  IRToolDef,
} from "../ir/types.js";

/** Anthropic requires max_tokens on every request. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

function decodeContentBlocks(raw: unknown, path: string, schemas: Map<string, Record<string, unknown>>): {
  parts: IRContentPart[];
  thinking: IRThinkingBlock[];
  toolCalls: IRToolCall[];
  toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
} {
  const parts: IRContentPart[] = [];
  const thinking: IRThinkingBlock[] = [];
  const toolCalls: IRToolCall[] = [];
  const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

  for (const [i, entry] of asArray(raw, path).entries()) {
    const p = `${path}[${i}]`;
    const block = asRecord(entry, p);
    const type = asString(block["type"], `${p}.type`);

    switch (type) {
      case "text":
        parts.push({ type: "text", text: asString(block["text"], `${p}.text`) });
        break;

      case "image": {
        const source = asRecord(block["source"], `${p}.source`);
        const sourceType = asString(source["type"], `${p}.source.type`);
        if (sourceType === "base64") {
          const mediaType = asString(source["media_type"], `${p}.source.media_type`);
          const data = asString(source["data"], `${p}.source.data`);
          // Anthropic splits the payload; the IR carries a URL like every
          // OpenAI-shaped provider expects.
          parts.push({ type: "image_url", url: `data:${mediaType};base64,${data}`, mime: mediaType });
        } else if (sourceType === "url") {
          const url = asString(source["url"], `${p}.source.url`);
          parts.push({ type: "image_url", url });
        } else {
          throw decodeError(`${p}.source.type`, `unsupported image source "${sourceType}"`);
        }
        break;
      }

      case "thinking": {
        const thinkingBlock: IRThinkingBlock = {
          type: "thinking",
          thinking: asString(block["thinking"], `${p}.thinking`),
        };
        const sig = optionalString(block["signature"], `${p}.signature`);
        if (sig !== undefined) thinkingBlock.signature = sig;
        thinking.push(thinkingBlock);
        break;
      }

      case "tool_use": {
        // Repaired and schema-validated at the IR boundary, exactly as on the
        // OpenAI side. A call that cannot be repaired is a decode error —
        // never a call with empty arguments.
        const name = asString(block["name"], `${p}.name`);
        const repaired = repairAndValidate(block["input"], schemas.get(name));
        if (!repaired.ok) throw decodeError(`${p}.input`, repaired.detail);
        toolCalls.push({ id: asString(block["id"], `${p}.id`), name, arguments: repaired.args });
        break;
      }

      case "tool_result": {
        const content = block["content"];
        // A tool_result carries either a string or a block array; both flatten
        // to text here because a tool's output is opaque to the gateway.
        let text: string;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .map((c, j) => {
              const cb = asRecord(c, `${p}.content[${j}]`);
              return cb["type"] === "text" ? String(cb["text"] ?? "") : "";
            })
            .join("");
        } else if (content === undefined || content === null) {
          text = "";
        } else {
          throw decodeError(`${p}.content`, "expected a string or an array of blocks");
        }
        const result: { tool_use_id: string; content: string; is_error?: boolean } = {
          tool_use_id: asString(block["tool_use_id"], `${p}.tool_use_id`),
          content: text,
        };
        const isError = optionalBoolean(block["is_error"], `${p}.is_error`);
        if (isError !== undefined) result.is_error = isError;
        toolResults.push(result);
        break;
      }

      default:
        throw decodeError(`${p}.type`, `unsupported content block "${type}"`);
    }
  }

  return { parts, thinking, toolCalls, toolResults };
}

function decodeSystem(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((entry, i) => {
        const block = asRecord(entry, `system[${i}]`);
        return block["type"] === "text" ? String(block["text"] ?? "") : "";
      })
      .join("");
  }
  throw decodeError("system", "expected a string or an array of text blocks");
}

export function decodeAnthropicRequest(body: unknown): IRRequest {
  const root = asRecord(body, "body");

  const model = asString(root["model"], "model");
  const maxTokens = optionalNumber(root["max_tokens"], "max_tokens");
  if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
    throw decodeError("max_tokens", "must be a positive number");
  }

  const rawMessages = asArray(root["messages"], "messages");
  if (rawMessages.length === 0) throw decodeError("messages", "must not be empty");

  // Declared schemas, so a repaired call is validated against the contract the
  // CALLER specified. Before the message loop, because an assistant turn can
  // carry tool calls that need it.
  const schemas = new Map<string, Record<string, unknown>>();

  const messages: IRMessage[] = [];
  for (const [i, entry] of rawMessages.entries()) {
    const p = `messages[${i}]`;
    const msg = asRecord(entry, p);
    const role = asString(msg["role"], `${p}.role`);

    if (role === "user" || role === "assistant") {
      // content may be a bare string on user turns.
      const rawContent = msg["content"];
      if (typeof rawContent === "string") {
        const message: IRMessage = { role, content: rawContent };
        messages.push(message);
        continue;
      }
      const { parts, thinking, toolCalls, toolResults } = decodeContentBlocks(rawContent, `${p}.content`, schemas);
      const message: IRMessage = { role, content: parts };
      if (thinking.length) message.thinking = thinking;
      if (toolCalls.length) message.tool_calls = toolCalls;
      messages.push(message);
      // A tool_result belongs in its own {role:"tool"} message, matching the
      // OpenAI shape every provider downstream expects. Anthropic nests it
      // inside the user turn, so the split happens here.
      for (const r of toolResults) {
        const toolMessage: IRMessage = {
          role: "tool",
          content: r.content,
          tool_call_id: r.tool_use_id,
        };
        if (r.is_error) toolMessage.name = "error";
        messages.push(toolMessage);
      }
      continue;
    }

    if (role === "system") {
      // A system turn inside `messages` is not part of the Messages API, but
      // some clients emit one; fold it into the request-level system prompt
      // rather than dropping the instruction on the floor.
      const rawContent = msg["content"];
      const text = typeof rawContent === "string"
        ? rawContent
        : decodeContentBlocks(rawContent, `${p}.content`, schemas).parts
            .filter((x): x is { type: "text"; text: string } => x.type === "text")
            .map((x) => x.text)
            .join("");
      messages.push({ role: "system", content: text });
      continue;
    }

    throw decodeError(`${p}.role`, `unsupported role "${role}"`);
  }

  const request: IRRequest = {
    model,
    messages,
    max_output_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream: optionalBoolean(root["stream"], "stream") ?? false,
  };

  const system = decodeSystem(root["system"]);
  if (system !== undefined) request.system = system;
  const temperature = optionalNumber(root["temperature"], "temperature");
  if (temperature !== undefined) request.temperature = temperature;
  const topP = optionalNumber(root["top_p"], "top_p");
  if (topP !== undefined) request.top_p = topP;
  const timeoutMs = optionalNumber(root["timeout_ms"], "timeout_ms");
  if (timeoutMs !== undefined) (request as { timeout_ms?: number }).timeout_ms = timeoutMs;

  if (Array.isArray(root["stop_sequences"])) {
    request.stop = asArray(root["stop_sequences"], "stop_sequences").map((s, i) => asString(s, `stop_sequences[${i}]`));
  }

  if (Array.isArray(root["tools"])) {
    request.tools = asArray(root["tools"], "tools").map((entry, i) => {
      const p = `tools[${i}]`;
      const tool = asRecord(entry, p);
      const def: IRToolDef = {
        name: asString(tool["name"], `${p}.name`),
        description: optionalString(tool["description"], `${p}.description`) ?? "",
        input_schema: asRecord(tool["input_schema"], `${p}.input_schema`),
      };
      schemas.set(def.name, def.input_schema);
      return def;
    });
  }

  return request;
}

/* ---------------------------------------------------------------- response */

export function anthropicStopReason(stop: IRStopReason): string {
  switch (stop) {
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    case "error":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function encodeAnthropicResponse(ir: IRResponse, requestId: string): Record<string, unknown> {
  // Anthropic's content array is ORDERED and heterogeneous: thinking first,
  // then text, then tool_use. The order is part of the contract.
  const content: Array<Record<string, unknown>> = [];

  for (const block of ir.thinking) {
    const out: Record<string, unknown> = { type: "thinking", thinking: block.thinking };
    if (block.signature !== undefined) out["signature"] = block.signature;
    content.push(out);
  }

  for (const part of ir.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    // A non-text part in a non-streaming reply is not representable in the
    // Messages shape; R5a adds image/audio blocks when that is needed.
  }

  for (const call of ir.tool_calls) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
  }

  return {
    id: requestId,
    type: "message",
    role: "assistant",
    model: ir.model,
    content,
    stop_reason: anthropicStopReason(ir.stop_reason),
    stop_sequence: null,
    usage: {
      input_tokens: ir.usage.input_tokens,
      output_tokens: ir.usage.output_tokens,
    },
  };
}
