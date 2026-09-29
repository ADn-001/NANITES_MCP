/**
 * OpenAI Chat Completions streaming.
 *
 * Much simpler than the Anthropic contract: `chat.completion.chunk` frames,
 * terminating with `data: [DONE]`. The two rules that still bite:
 *
 *  - The FIRST chunk carries `delta.role = "assistant"`. Clients that render
 *    incrementally rely on it to open the message bubble.
 *  - `tool_calls[].index` must be CONSISTENT across every chunk. A client
 *    concatenates fragments by index, so a missing or shifted index silently
 *    interleaves two calls' arguments.
 *
 * As with the Anthropic side, tool-argument fragments are forwarded RAW.
 */
import type { SseWriter } from "./sse.js";
import type { UpstreamEvent, Assembled } from "./upstream.js";

export interface OpenAiStreamEncoder {
  start(model: string, id: string, created: number): Promise<void>;
  handle(event: UpstreamEvent): Promise<void>;
  endAll(assembled: Assembled): Promise<void>;
  readonly ended: boolean;
  readonly chunksEmitted: number;
}

export function createOpenAiStream(
  writer: SseWriter,
  id: string,
  created: number,
  model = "",
): OpenAiStreamEncoder {
  let started = false;
  let ended = false;
  let chunks = 0;
  /** upstream tool index -> the id/name announced on its first chunk. */
  const announced = new Map<number, { id: string; name: string }>();

  // `id`, `model` and `created` are repeated on every chunk. Clients that
  // accumulate a response from any single frame (rather than the first) rely
  // on them being present, and some log an empty model when they are not.
  const chunk = async (delta: Record<string, unknown>, finish: string | null = null): Promise<void> => {
    chunks += 1;
    await writer.data({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  };

  return {
    get ended() {
      return ended;
    },
    get chunksEmitted() {
      return chunks;
    },

    async start(startModel) {
      if (started) return;
      model = startModel || model;
      started = true;
      chunks += 1;
      // The role-only opener. Empty content is required so a client does not
      // treat the first frame as a content delta.
      await writer.data({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    },

    async handle(event) {
      if (!started) return;
      switch (event.type) {
        case "text":
          await chunk({ content: event.delta });
          return;
        case "thinking":
          // OpenAI chat.completions has no thinking channel. It is DROPPED
          // here rather than smuggled into content as prose, which would leak
          // reasoning the provider chose to withhold. The reasoning-extension
          // channel is a later, opt-in addition.
          return;
        case "tool_start": {
          announced.set(event.index, { id: event.id, name: event.name });
          // id and name on their own chunk; arguments on subsequent ones.
          await chunk({
            tool_calls: [{ index: event.index, id: event.id, type: "function", function: { name: event.name, arguments: "" } }],
          });
          return;
        }
        case "tool_delta": {
          const meta = announced.get(event.index);
          if (!meta) return;
          await chunk({
            tool_calls: [{ index: event.index, function: { arguments: event.args_fragment } }],
          });
          return;
        }
        default:
          return;
      }
    },

    async endAll(assembled) {
      if (ended) return;
      ended = true;
      const finish = assembled.toolCalls.length
        ? "tool_calls"
        : assembled.finish_reason === "length"
          ? "length"
          : "stop";

      chunks += 1;
      await writer.data({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        usage: {
          prompt_tokens: assembled.usage.input_tokens,
          completion_tokens: assembled.usage.output_tokens,
          total_tokens: assembled.usage.input_tokens + assembled.usage.output_tokens,
        },
      });
      // [DONE] is the terminator, and it must be last, unquoted, and appear
      // exactly once. `rawData`, not `data` — a JSON-encoded "[DONE]" arrives
      // as data: "[DONE]" and every OpenAI SDK waits forever for the real one.
      await writer.rawData("[DONE]");
    },
  };
}
