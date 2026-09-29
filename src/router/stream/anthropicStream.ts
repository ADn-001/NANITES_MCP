/**
 * The Anthropic Messages streaming state machine.
 *
 * Required sequence, in order, with correct indexes:
 *
 *   message_start
 *     content_block_start   {index, content_block}
 *     content_block_delta*  {index, delta}
 *     content_block_stop    {index}
 *   message_delta          {delta:{stop_reason}, usage:{output_tokens}}
 *   message_stop
 *
 * Rules that have each broken someone's implementation:
 *
 *  - Every `content_block_start` gets EXACTLY ONE `content_block_stop`.
 *    A dangling open block hangs the client. `endAll()` closes whatever is
 *    still open, so no code path can emit an unterminated stream.
 *  - Indexes are sequential from 0 and monotonic.
 *  - Tool `input_json_delta` fragments are forwarded RAW. The assembled string
 *    is parsed ONCE, at content_block_stop, by the R6 repair ladder.
 *  - `message_start` carries real `input_tokens`; the final `message_delta`
 *    carries real cumulative `output_tokens`. Both are frequently wrong.
 *  - A `ping` at least every 30s on long generations, or an intermediary
 *    closes an idle connection.
 *  - An error mid-stream STILL emits `message_stop`. The client is not left
 *    waiting for a terminator that never arrives.
 */
import type { SseWriter } from "./sse.js";
import type { UpstreamEvent, Assembled } from "./upstream.js";

type BlockKind = "text" | "thinking" | "tool_use";

interface OpenBlock {
  index: number;
  kind: BlockKind;
  toolId?: string;
  toolName?: string;
}

export interface AnthropicStreamEncoder {
  start(estimatedInputTokens: number, model: string, messageId: string): Promise<void>;
  handle(event: UpstreamEvent): Promise<void>;
  /** Close open blocks, emit message_delta + message_stop. Idempotent. */
  endAll(assembled: Assembled): Promise<void>;
  readonly openBlocks: number;
  readonly eventsEmitted: number;
}

export function createAnthropicStream(
  writer: SseWriter,
  messageId: string,
): AnthropicStreamEncoder {
  const open: OpenBlock[] = [];
  let nextIndex = 0;
  let started = false;
  let ended = false;
  let emitted = 0;
  /** tool index (upstream) -> our content block index, so fragments land right. */
  const toolBlockIndex = new Map<number, number>();

  const emit = async (name: string, payload: unknown): Promise<void> => {
    emitted += 1;
    await writer.event(name, payload);
  };

  const closeBlock = async (block: OpenBlock): Promise<void> => {
    await emit("content_block_stop", { type: "content_block_stop", index: block.index });
    const at = open.indexOf(block);
    if (at >= 0) open.splice(at, 1);
  };

  return {
    get openBlocks() {
      return open.length;
    },
    get eventsEmitted() {
      return emitted;
    },

    async start(estimatedInputTokens, model) {
      if (started) return;
      started = true;
      // input_tokens here is an ESTIMATE, because the provider has not been
      // contacted yet and the real number is unknowable at this point.
      //
      // This is safe, and worth being precise about why: Anthropic clients
      // read the authoritative count from the FINAL accumulated message
      // (message_delta's usage block), not from message_start. A zero here is
      // not a broken endpoint — a fully prompt-cached request legitimately
      // reports 0 uncached input tokens. A chars/4 estimate is strictly more
      // useful than a hard zero, and the real figure overwrites it below.
      await emit("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
        },
      });
    },

    async handle(event) {
      if (!started) return;
      switch (event.type) {
        case "text": {
          // Text arriving while a tool_use block is open would be appended to
          // the wrong block. Close it first — the contract is one block per
          // kind, in order.
          const current = open[open.length - 1];
          if (current && current.kind === "tool_use") await closeBlock(current);

          let block = open.find((b) => b.kind === "text");
          if (!block) {
            block = { index: nextIndex++, kind: "text" };
            open.push(block);
            await emit("content_block_start", {
              type: "content_block_start", index: block.index,
              content_block: { type: "text", text: "" },
            });
          }
          await emit("content_block_delta", {
            type: "content_block_delta", index: block.index,
            delta: { type: "text_delta", text: event.delta },
          });
          return;
        }

        case "thinking": {
          let block = open.find((b) => b.kind === "thinking");
          if (!block) {
            block = { index: nextIndex++, kind: "thinking" };
            open.push(block);
            await emit("content_block_start", {
              type: "content_block_start", index: block.index,
              content_block: { type: "thinking", thinking: "", signature: "" },
            });
          }
          await emit("content_block_delta", {
            type: "content_block_delta", index: block.index,
            delta: { type: "thinking_delta", thinking: event.delta },
          });
          return;
        }

        case "signature": {
          const block = open.find((b) => b.kind === "thinking");
          if (!block) return;
          await emit("content_block_delta", {
            type: "content_block_delta", index: block.index,
            delta: { type: "signature_delta", signature: event.delta },
          });
          return;
        }

        case "tool_start": {
          // Close whatever text was open so the blocks stay contiguous.
          while (open.length) await closeBlock(open[open.length - 1]!);
          const block: OpenBlock = {
            index: nextIndex++,
            kind: "tool_use",
            toolId: event.id,
            toolName: event.name,
          };
          open.push(block);
          toolBlockIndex.set(event.index, block.index);
          await emit("content_block_start", {
            type: "content_block_start", index: block.index,
            content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
          });
          return;
        }

        case "tool_delta": {
          const index = toolBlockIndex.get(event.index);
          if (index === undefined) return;
          // RAW fragment. Not parsed here — a partial JSON fragment is not
          // valid JSON, and parsing mid-stream is how tool calls get corrupted.
          await emit("content_block_delta", {
            type: "content_block_delta", index,
            delta: { type: "input_json_delta", partial_json: event.args_fragment },
          });
          return;
        }

        case "usage":
        case "finish":
        case "error":
          // Usage and finish are applied at endAll, where the totals are
          // known. An error mid-stream is reported by the caller calling
          // endAll — which always emits message_stop.
          return;
      }
    },

    async endAll(assembled) {
      if (ended) return;
      ended = true;

      // Close every block still open. This is the guarantee that no path
      // emits an unterminated stream.
      while (open.length) await closeBlock(open[open.length - 1]!);

      const stopReason = assembled.toolCalls.length
        ? "tool_use"
        : assembled.finish_reason === "length"
          ? "max_tokens"
          : "end_turn";

      // BOTH real counts land here. This is the block Anthropic's own SDKs
      // accumulate into `finalMessage().usage`, so it is the one that has to be
      // correct; the estimate in message_start is cosmetic.
      await emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: assembled.usage.input_tokens,
          output_tokens: assembled.usage.output_tokens,
        },
      });
      await emit("message_stop", { type: "message_stop" });
    },
  };
}
