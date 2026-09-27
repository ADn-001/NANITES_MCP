/**
 * SSE parser + reassembly for `/api/v1/chat` streaming responses.
 *
 * Wire format (doc 03): each event block is
 *   `event: <type>\ndata: <json>\n\n`
 * The stream always begins with `chat.start` and ends with `chat.end`, whose
 * `result` is the aggregated non-streaming response shape.
 */
import type { ChatResponse } from "./types.js";
import { truncatedStreamError } from "./errors.js";

export interface ChatStreamEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

const BLANK_LINE = /\r?\n\r?\n/;
/** Global instance: lastIndex is reset explicitly before each drain. */
const SEPARATOR = new RegExp(BLANK_LINE.source, "g");

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split on a CR-tolerant boundary, matching either line ending.
      //
      // The pattern matters: the old indexOf looked for two adjacent newlines,
      // which a CRLF blank-line separator does not contain, so the buffer never
      // drained, zero events were yielded, and the idle timer — re-armed by each
      // event — never fired again, killing the stream as generation_idle_timeout
      // exactly when the first token should have landed.
      // parseBlock already stripped a trailing CR per line, so CRLF was clearly
      // intended all along.
      //
      // The cursor matters too: re-slicing `buffer` inside the loop desynchronises
      // the global regex lastIndex from the string it indexes, which silently
      // yields only the first few blocks. An offset into the untouched buffer is
      // the correct shape.
      SEPARATOR.lastIndex = 0;
      let m: RegExpExecArray | null;
      let cursor = 0;
      while ((m = SEPARATOR.exec(buffer)) !== null) {
        const block = buffer.slice(cursor, m.index);
        cursor = m.index + m[0].length;
        const parsed = parseBlock(block);
        if (parsed) {
          const event = tryParseData(parsed);
          if (event) yield event;
        }
      }
      buffer = buffer.slice(cursor);
    }
    // Trailing block with no final blank line.
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseBlock(tail);
      if (parsed) {
        const event = tryParseData(parsed);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * OpenAI-compat SSE streams terminate with `data: [DONE]` (and may include
 * keep-alive blocks that are not JSON). Those are transport terminators, not
 * events — skip any block whose payload does not parse rather than throwing,
 * so the tolerant parser stays compatible with both wire formats.
 */
function tryParseData(parsed: { event: string; data: string }): ChatStreamEvent | null {
  try {
    return { type: parsed.event, data: JSON.parse(parsed.data) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export interface ReassembledChat {
  response: ChatResponse;
  /** Every event seen, in order — used by the Phase 2 runaway detector. */
  events: ChatStreamEvent[];
}

/** Consume a stream and rebuild the aggregated response from `chat.end`. */
export async function reassembleChatStream(
  events: AsyncIterable<ChatStreamEvent>,
  onEvent?: (event: ChatStreamEvent) => void,
): Promise<ReassembledChat> {
  const seen: ChatStreamEvent[] = [];
  let response: ChatResponse | null = null;
  for await (const event of events) {
    seen.push(event);
    if (onEvent) onEvent(event);
    if (event.type === "chat.end") {
      const result = (event.data as { result: ChatResponse }).result;
      if (result && typeof result === "object") {
        response = result;
      }
    }
  }
  if (!response) {
    throw truncatedStreamError();
  }
  return { response, events: seen };
}

// ---- OpenAI-compat (`/v1/chat/completions`) wire adapter ----
//
// The OpenAI stream has no `event:` lines (every block parses as `message`)
// and terminates with `data: [DONE]` (skipped by the tolerant parser). There is
// no aggregated `chat.end` carrying a ChatResponse, so this adapter normalizes
// the wire to the native event shape: content deltas re-yield as
// `message.delta` (drives idle-reset + live reply build-up), reasoning deltas
// as `reasoning.delta` (idle activity, not reply text), and a synthetic
// `chat.end` closes with a ChatResponse whose stats are synthesized from the
// OpenAI `usage` object. Consumers downstream of `reassembleChatStream` never
// see the wire change.

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAiStreamChoice {
  delta?: { content?: string; reasoning_content?: string };
  finish_reason?: string | null;
}

export interface OpenAiStreamChunk {
  usage?: OpenAiUsage;
  choices?: OpenAiStreamChoice[];
}

export interface SynthesizeArgs {
  content: string;
  usage?: OpenAiUsage | null;
  sawReasoning: boolean;
  startedAt: number;
  endedAt: number;
  firstContentAt: number | null;
  /** First emitted token (reasoning or content), for the tokens-per-second
   * window. When the model reasons first, the completion_tokens count includes
   * the thinking burst, so the rate must span from the first *any* delta —
   * measuring from first content would divide all tokens by the content-only
   * tail and inflate tps absurdly (observed live: 27k t/s). */
  firstTokenAt?: number | null;
}

/**
 * Build the native ChatResponse shape from an OpenAI-compatible completion.
 * OpenAI's usage carries `prompt_tokens`/`completion_tokens` but no
 * per-stream tokens-per-second or time-to-first-token, so those are measured
 * here against wall clock. Cold-JIT ttft therefore includes the model load
 * latency the native path paid separately — accepted: it is the real
 * user-perceived latency, and the scorer's TTFT_FLOOR_MS already zeroes it.
 */
export function synthesizeOpenAiResponse(modelKey: string, args: SynthesizeArgs): ChatResponse {
  const completionTokens = args.usage?.completion_tokens ?? 0;
  const reasoningTokens = args.usage?.completion_tokens_details?.reasoning_tokens;
  // Absent an explicit split (server may fold reasoning into completion_tokens
  // without exposing details), never fabricate a reasoning count — a guess
  // would double-count tokens in the ledger. Reasoning-type learning upstream
  // keys off `reasoning_output_tokens > 0`, which still fires when details are
  // present.
  const reasoningOutputTokens = typeof reasoningTokens === "number" ? reasoningTokens : 0;
  const genStart = args.firstTokenAt ?? args.firstContentAt ?? args.startedAt;
  const genElapsedS = args.endedAt > genStart ? (args.endedAt - genStart) / 1000 : 0;
  const stats = {
    input_tokens: args.usage?.prompt_tokens ?? 0,
    total_output_tokens: completionTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    tokens_per_second: genElapsedS > 0 && completionTokens > 0 ? completionTokens / genElapsedS : 0,
    time_to_first_token_seconds:
      args.firstContentAt !== null ? (args.firstContentAt - args.startedAt) / 1000 : 0,
  };
  return {
    model_instance_id: modelKey,
    output: args.content ? [{ type: "message" as const, content: args.content }] : [],
    stats,
  };
}

/** Yield native-shaped events from an OpenAI SSE response body. */
export async function* openAiChatEvents(
  body: ReadableStream<Uint8Array>,
  modelKey: string,
): AsyncGenerator<ChatStreamEvent> {
  // High-res clock: ttft/tps are measured across sub-ms local streams too.
  const startedAt = performance.now();
  let content = "";
  let firstContentAt: number | null = null;
  let firstTokenAt: number | null = null;
  let sawReasoning = false;
  let usage: OpenAiUsage | null = null;
  for await (const ev of readSseEvents(body)) {
    if (ev.type !== "message") continue;
    const chunk = ev.data as OpenAiStreamChunk;
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.content === "string" && delta.content !== "") {
      if (firstContentAt === null) firstContentAt = performance.now();
      if (firstTokenAt === null) firstTokenAt = firstContentAt;
      content += delta.content;
      yield { type: "message.delta", data: { content: delta.content } };
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      sawReasoning = true;
      if (firstTokenAt === null) firstTokenAt = performance.now();
      yield { type: "reasoning.delta", data: { content: delta.reasoning_content } };
    }
  }
  yield {
    type: "chat.end",
    data: {
      result: synthesizeOpenAiResponse(modelKey, {
        content,
        usage,
        sawReasoning,
        startedAt,
        endedAt: performance.now(),
        firstContentAt,
        firstTokenAt,
      }),
    },
  };
}
