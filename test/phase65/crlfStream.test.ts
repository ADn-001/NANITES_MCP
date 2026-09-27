/**
 * Phase 65 gate — the SSE splitter must handle CRLF.
 *
 * The splitter looked for two adjacent newlines. A CRLF blank-line separator
 * contains no adjacent pair, so the buffer never drained, zero events were
 * yielded, and the idle timer — which is re-armed by each event — never fired
 * again. The stream then died as generation_idle_timeout exactly when the
 * first token should have landed.
 *
 * The first fix for this re-sliced `buffer` inside the match loop, which
 * desynchronises a global regex lastIndex from the string it indexes: the
 * stream test caught it at 3 of 16 events. These cases pin the count, so that
 * shape cannot come back.
 */
import { describe, expect, it } from "vitest";
import { readSseEvents } from "../../src/lmstudio/chatStream.js";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

function frame(event: string, data: unknown, line: string, blank: string): string {
  return "event: " + event + line + "data: " + JSON.stringify(data) + blank;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

async function types(text: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of readSseEvents(streamOf(text))) out.push(e.type);
  return out;
}

const EVENTS = [
  { event: "chat.start", data: { type: "chat.start" } },
  { event: "model_load.start", data: { type: "model_load.start" } },
  { event: "model_load.progress", data: { type: "model_load.progress", progress: 0.65 } },
  { event: "model_load.end", data: { type: "model_load.end" } },
  { event: "prompt_processing.start", data: { type: "prompt_processing.start" } },
  { event: "prompt_processing.end", data: { type: "prompt_processing.end" } },
  { event: "reasoning.start", data: { type: "reasoning.start" } },
  { event: "reasoning.delta", data: { type: "reasoning.delta", content: "Think" } },
  { event: "reasoning.end", data: { type: "reasoning.end" } },
  { event: "message.start", data: { type: "message.start" } },
  { event: "message.delta", data: { type: "message.delta", content: "Hello" } },
  { event: "message.end", data: { type: "message.end" } },
  { event: "chat.end", data: { type: "chat.end" } },
];

describe("SSE block splitting", () => {
  it("yields every event from an LF stream", async () => {
    const body = EVENTS.map((e) => frame(e.event, e.data, LF, LF + LF)).join("");
    expect(await types(body)).toEqual(EVENTS.map((e) => e.data.type as string));
  });

  it("yields every event from a CRLF stream (H13)", async () => {
    const body = EVENTS.map((e) => frame(e.event, e.data, CR + LF, CR + LF + CR + LF)).join("");
    // Pre-fix this returned an empty list, and the client then threw
    // "stream ended before chat.end".
    expect(await types(body)).toEqual(EVENTS.map((e) => e.data.type as string));
  });

  it("yields every event from a mixed-ending stream", async () => {
    const body = EVENTS.map((e, i) =>
      frame(e.event, e.data, i % 2 === 0 ? LF : CR + LF, i % 2 === 0 ? LF + LF : CR + LF + CR + LF),
    ).join("");
    expect(await types(body)).toEqual(EVENTS.map((e) => e.data.type as string));
  });

  it("handles a final block with no trailing blank line", async () => {
    const body = EVENTS.map((e, i) =>
      i === EVENTS.length - 1 ? frame(e.event, e.data, LF, "") : frame(e.event, e.data, LF, LF + LF),
    ).join("");
    expect(await types(body)).toEqual(EVENTS.map((e) => e.data.type as string));
  });

  it("reassembles a CRLF stream split across chunk boundaries", async () => {
    const body = EVENTS.map((e) => frame(e.event, e.data, CR + LF, CR + LF + CR + LF)).join("");
    const encoded = new TextEncoder().encode(body);
    // Chunk mid-separator, which is where a naive byte-offset split fails.
    const cut = Math.floor(encoded.length / 2);
    const out: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, cut));
        controller.enqueue(encoded.slice(cut));
        controller.close();
      },
    });
    for await (const e of readSseEvents(stream)) out.push(e.type);
    expect(out).toEqual(EVENTS.map((e) => e.data.type as string));
  });
});
