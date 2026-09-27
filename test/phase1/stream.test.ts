import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LmStudioClient } from "../../src/lmstudio/client.js";
import { sendJson, sendText, startMockLmStudio, type MockLmStudio } from "./mockServer.js";
import { chatResponseFixture, serializeSse, streamingEventsFixture } from "./fixtures.js";

function streamAwareHandler(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", "http://mock");
  if (url.pathname !== "/api/v1/chat") {
    return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
  }
  const parsed = JSON.parse(body || "{}") as { stream?: boolean };
  if (parsed.stream) {
    const text = serializeSse(streamingEventsFixture);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  } else {
    sendJson(res, 200, chatResponseFixture);
  }
}

describe("LmStudioClient — streaming chat reassembly", () => {
  let mock: MockLmStudio;
  let client: LmStudioClient;

  beforeAll(async () => {
    mock = await startMockLmStudio(streamAwareHandler);
    client = new LmStudioClient({ baseUrl: mock.url });
  });

  afterAll(async () => {
    await mock.close();
  });

  it("reassembles the SSE event sequence into the non-streaming response shape", async () => {
    const streaming = await client.chat("qwen/qwen3-vl-4b", "Describe this image", { stream: true });
    expect(streaming.response).toEqual(chatResponseFixture);

    const nonStreaming = await client.chat("qwen/qwen3-vl-4b", "Describe this image");
    expect(streaming.response).toEqual(nonStreaming.response);
  });

  it("exposes the raw event sequence in order", async () => {
    const { events } = await client.chat("qwen/qwen3-vl-4b", "Describe this image", { stream: true });
    expect(events).toHaveLength(streamingEventsFixture.length);
    expect(events[0]!.type).toBe("chat.start");
    expect(events[events.length - 1]!.type).toBe("chat.end");
    const deltas = events.filter((e) => e.type === "message.delta").map((e) => e.data.content as string);
    expect(deltas.join("")).toBe("This image is red.");
  });

  it("streamChatEvents yields the same events in order", async () => {
    const seen: string[] = [];
    for await (const event of client.streamChatEvents("qwen/qwen3-vl-4b", "Describe this image")) {
      seen.push(event.type);
    }
    expect(seen[0]).toBe("chat.start");
    expect(seen[seen.length - 1]).toBe("chat.end");
    expect(seen).toHaveLength(streamingEventsFixture.length);
  });

  it("a stream that ends before chat.end yields truncated_stream", async () => {
    const partial = streamingEventsFixture.slice(0, 3); // chat.start, model_load.start, model_load.progress
    const m2 = await startMockLmStudio((_req, res) => {
      const text = serializeSse(partial);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    });
    try {
      const c = new LmStudioClient({ baseUrl: m2.url });
      await expect(c.chat("qwen/qwen3-vl-4b", "hi", { stream: true })).rejects.toMatchObject({ code: "truncated_stream" });
    } finally {
      await m2.close();
    }
  });

  it("a stream whose chat.end has no result yields truncated_stream", async () => {
    const bad = [
      { event: "chat.start", data: { type: "chat.start", model_instance_id: "m" } },
      { event: "chat.end", data: { type: "chat.end" } },
    ];
    const m2 = await startMockLmStudio((_req, res) => {
      const text = serializeSse(bad);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    });
    try {
      const c = new LmStudioClient({ baseUrl: m2.url });
      await expect(c.chat("m", "hi", { stream: true })).rejects.toMatchObject({ code: "truncated_stream" });
    } finally {
      await m2.close();
    }
  });
});
