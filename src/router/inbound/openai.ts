/**
 * OpenAI Chat Completions <-> IR.
 *
 * Pure functions, same contract as the Anthropic side. The vocabulary differs
 * (tools are `function`-wrapped, `parameters` instead of `input_schema`,
 * `finish_reason` instead of `stop_reason`) but the mapping is mechanical.
 *
 * Field mapping, complete:
 *   messages[].content (string|parts) -> IRMessage.content
 *     {type:"text"}        -> {type:"text"}
 *     {type:"image_url"}   -> {type:"image_url",url}
 *     {type:"input_audio"} -> {type:"input_audio",data,mime}
 *     {type:"video_url"}   -> {type:"video_url",url}      (OpenRouter extension)
 *   messages[].tool_calls  -> IRMessage.tool_calls
 *   messages[].tool_call_id/name -> IRMessage equivalents
 *   tools[].function       -> IRToolDef
 *   max_tokens             -> IRRequest.max_output_tokens
 *   max_completion_tokens  -> IRRequest.max_output_tokens  (wins; it is the
 *                              modern field and a client sending both means it)
 *   stop (string|array)    -> IRRequest.stop
 *   stream                 -> IRRequest.stream
 *
 * Dropped, and why:
 *   n > 1                  -> the gateway serves ONE completion per request;
 *                              n>1 is not representable in a single reply
 *   logprobs/top_logprobs  -> unused; no consumer of them exists
 *   presence/frequency penalty, seed, service_tier, user
 *                         -> accepted-and-ignored upstream
 *   stream_options         -> R2; it only affects whether usage is streamed
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
  IRToolCall,
  IRToolDef,
} from "../ir/types.js";

const OPENAI_DEFAULT_MAX_TOKENS = 4096;

function decodeContentParts(raw: unknown, path: string): IRContentPart[] {
  const parts: IRContentPart[] = [];
  for (const [i, entry] of asArray(raw, path).entries()) {
    const p = `${path}[${i}]`;
    const part = asRecord(entry, p);
    const type = asString(part["type"], `${p}.type`);

    switch (type) {
      case "text":
      case "input_text":
        parts.push({ type: "text", text: asString(part["text"], `${p}.text`) });
        break;

      case "image_url": {
        const holder = asRecord(part["image_url"], `${p}.image_url`);
        parts.push({ type: "image_url", url: asString(holder["url"], `${p}.image_url.url`) });
        break;
      }

      case "input_audio": {
        const holder = asRecord(part["input_audio"], `${p}.input_audio`);
        const data = asString(holder["data"], `${p}.input_audio.data`);
        // OpenAI sends either a bare base64 payload or a full data URI
        // depending on the SDK version. Normalise to bare base64, because that
        // is the field's declared content.
        const mime = holder["format"] !== undefined
          ? audioMimeFor(String(holder["format"]))
          : mimeFromDataUri(data) ?? "audio/wav";
        parts.push({
          type: "input_audio",
          data: data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data,
          mime,
        });
        break;
      }

      case "video_url": {
        const holder = asRecord(part["video_url"], `${p}.video_url`);
        parts.push({ type: "video_url", url: asString(holder["url"], `${p}.video_url.url`) });
        break;
      }

      default:
        throw decodeError(`${p}.type`, `unsupported content part "${type}"`);
    }
  }
  return parts;
}

function audioMimeFor(format: string): string {
  const f = format.toLowerCase();
  if (f === "mp3") return "audio/mpeg";
  if (f === "opus") return "audio/opus";
  if (f === "aac") return "audio/aac";
  if (f === "flac") return "audio/flac";
  if (f === "wav" || f === "pcm16") return "audio/wav";
  return `audio/${f}`;
}

function mimeFromDataUri(data: string): string | null {
  if (!data.startsWith("data:")) return null;
  const end = data.indexOf(";");
  if (end < 0) return null;
  return data.slice("data:".length, end);
}

/**
 * Decode tool calls, repairing the arguments.
 *
 * This is the SINGLE point where a tool call enters the IR, so repairing here
 * means every downstream consumer benefits and there is exactly one place to
 * audit. A call whose arguments cannot be repaired is a decode error — never a
 * call with empty arguments, which is the silent failure this replaces.
 */
function decodeToolCalls(raw: unknown, path: string, schemas: Map<string, Record<string, unknown>>): IRToolCall[] {
  return asArray(raw, path).map((entry, i) => {
    const p = `${path}[${i}]`;
    const call = asRecord(entry, p);
    const fn = asRecord(call["function"], `${p}.function`);
    const name = asString(fn["name"], `${p}.function.name`);

    const repaired = repairAndValidate(fn["arguments"], schemas.get(name));
    if (!repaired.ok) {
      throw decodeError(`${p}.function.arguments`, `${repaired.detail}`);
    }
    return {
      id: asString(call["id"], `${p}.id`),
      name,
      arguments: repaired.args,
    };
  });
}

export function decodeOpenAiRequest(body: unknown): IRRequest {
  const root = asRecord(body, "body");

  const model = asString(root["model"], "model");
  const rawMessages = asArray(root["messages"], "messages");
  if (rawMessages.length === 0) throw decodeError("messages", "must not be empty");

  // The declared schemas, so a repaired call is validated against the contract
  // the CALLER specified rather than merely against "is it an object".
  // Declared before the message loop because an assistant turn can carry tool
  // calls that need it.
  const toolSchemas = new Map<string, Record<string, unknown>>();

  const messages: IRMessage[] = [];
  for (const [i, entry] of rawMessages.entries()) {
    const p = `messages[${i}]`;
    const msg = asRecord(entry, p);
    const role = asString(msg["role"], `${p}.role`);

    if (role === "developer") {
      // The newer name for the system role. Carry it, do not drop it.
      const content = msg["content"];
      const text = typeof content === "string" ? content : flattenText(content, `${p}.content`);
      messages.push({ role: "system", content: text });
      continue;
    }

    if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
      const content = msg["content"];
      const message: IRMessage = {
        role,
        content: typeof content === "string" || content === null || content === undefined
          ? (content ?? "")
          : decodeContentParts(content, `${p}.content`),
      };
      if (role === "tool") {
        const id = optionalString(msg["tool_call_id"], `${p}.tool_call_id`);
        if (id !== undefined) message.tool_call_id = id;
        const name = optionalString(msg["name"], `${p}.name`);
        if (name !== undefined) message.name = name;
      }
      if (role === "assistant" && Array.isArray(msg["tool_calls"])) {
        message.tool_calls = decodeToolCalls(msg["tool_calls"], `${p}.tool_calls`, toolSchemas);
      }
      messages.push(message);
      continue;
    }

    throw decodeError(`${p}.role`, `unsupported role "${role}"`);
  }

  // max_completion_tokens supersedes the deprecated max_tokens when both are
  // present; a client sending both means the newer one.
  const maxCompletion = optionalNumber(root["max_completion_tokens"], "max_completion_tokens");
  const legacyMax = optionalNumber(root["max_tokens"], "max_tokens");
  const maxTokens = maxCompletion ?? legacyMax;
  if (maxTokens !== undefined && maxTokens <= 0) {
    throw decodeError("max_tokens", "must be a positive number");
  }

  const request: IRRequest = {
    model,
    messages,
    max_output_tokens: maxTokens ?? OPENAI_DEFAULT_MAX_TOKENS,
    stream: optionalBoolean(root["stream"], "stream") ?? false,
  };

  const temperature = optionalNumber(root["temperature"], "temperature");
  if (temperature !== undefined) request.temperature = temperature;
  const topP = optionalNumber(root["top_p"], "top_p");
  if (topP !== undefined) request.top_p = topP;

  // A caller-declared generation budget. Non-standard on both dialects, so it
  // is opt-in and simply ignored by a client that does not know about it.
  const timeoutMs = optionalNumber(root["timeout_ms"], "timeout_ms");
  if (timeoutMs !== undefined) (request as { timeout_ms?: number }).timeout_ms = timeoutMs;

  const stop = root["stop"];
  if (typeof stop === "string") request.stop = [stop];
  else if (Array.isArray(stop)) request.stop = asArray(stop, "stop").map((s, i) => asString(s, `stop[${i}]`));

  if (Array.isArray(root["tools"])) {
    request.tools = asArray(root["tools"], "tools").map((entry, i) => {
      const p = `tools[${i}]`;
      const tool = asRecord(entry, p);
      const fn = asRecord(tool["function"], `${p}.function`);
      const def: IRToolDef = {
        name: asString(fn["name"], `${p}.function.name`),
        description: optionalString(fn["description"], `${p}.function.description`) ?? "",
        input_schema: asRecord(fn["parameters"], `${p}.function.parameters`),
      };
      toolSchemas.set(def.name, def.input_schema);
      return def;
    });
  }

  return request;
}

function flattenText(raw: unknown, path: string): string {
  return decodeContentParts(raw, path)
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/* ---------------------------------------------------------------- response */

export function openaiFinishReason(stop: IRStopReason): string {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

export function encodeOpenAiResponse(ir: IRResponse, responseId: string, createdUnix: number): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: textOf(ir),
  };
  if (ir.tool_calls.length) {
    message["tool_calls"] = ir.tool_calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
  }

  return {
    id: responseId,
    object: "chat.completion",
    created: createdUnix,
    model: ir.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: openaiFinishReason(ir.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: ir.usage.input_tokens,
      completion_tokens: ir.usage.output_tokens,
      total_tokens: ir.usage.input_tokens + ir.usage.output_tokens,
    },
  };
}

function textOf(ir: IRResponse): string {
  return ir.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
