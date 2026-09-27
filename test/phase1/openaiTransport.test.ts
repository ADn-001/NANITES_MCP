/**
 * Phase T unit gate — the LmStudioClient openai transport seam. The same
 * client call over `/v1/chat/completions` (with `ttl`) must yield the same
 * native ChatResponse/ChatStats shape a native `/api/v1/chat` call does, the
 * request body must be translated (`max_output_tokens` -> `max_tokens`,
 * string input -> messages, ttl added, integrations absent), and the parser
 * must survive the OpenAI `data: [DONE]` terminator.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LmStudioClient } from "../../src/lmstudio/client.js";
import { sendJson, sendOpenAiChatStream, startMockLmStudio, type MockLmStudio } from "./mockServer.js";

describe("LmStudioClient — openai transport (/v1/chat/completions + ttl)", () => {
  let mock: MockLmStudio;
  let client: LmStudioClient;
  const bodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    mock = await startMockLmStudio((req: IncomingMessage, res: ServerResponse, body: string) => {
      const url = new URL(req.url ?? "/", "http://mock");
      if (url.pathname !== "/v1/chat/completions") {
        return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
      }
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      bodies.push(parsed);
      if (parsed.stream === true) {
        return sendOpenAiChatStream(res, "This image is red.", { prompt_tokens: 100, completion_tokens: 20 });
      }
      return sendJson(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "This image is red." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    });
    client = new LmStudioClient({ baseUrl: mock.url });
  });

  afterAll(async () => {
    await mock.close();
  });

  it("streaming openai chat reassembles into the native shape with synthesized stats", async () => {
    const { response, events } = await client.chat(
      "mock/model-key",
      "Describe this image",
      { stream: true, max_output_tokens: 100, system_prompt: "sys", temperature: 0.3, reasoning: "on" },
      { transport: "openai", ttl_s: 45, idleTimeoutMs: 2000 },
    );
    expect(response.output).toEqual([{ type: "message", content: "This image is red." }]);
    expect(response.stats.input_tokens).toBe(100);
    expect(response.stats.total_output_tokens).toBe(20);
    expect(response.stats.time_to_first_token_seconds).toBeGreaterThan(0);
    expect(response.stats.tokens_per_second).toBeGreaterThan(0);
    const deltas = events.filter((e) => e.type === "message.delta").map((e) => e.data.content as string);
    expect(deltas.join("")).toBe("This image is red.");
    expect(events[events.length - 1]!.type).toBe("chat.end");
  });

  it("non-streaming openai chat returns the same synthesized shape", async () => {
    const { response } = await client.chat(
      "mock/model-key",
      "Describe this image",
      { max_output_tokens: 100, system_prompt: "sys" },
      { transport: "openai", ttl_s: 45 },
    );
    expect(response.output).toEqual([{ type: "message", content: "This image is red." }]);
    expect(response.stats.input_tokens).toBe(100);
    expect(response.stats.total_output_tokens).toBe(20);
  });

  it("request body is translated: model key, messages, max_tokens, ttl, no integrations", () => {
    const streamed = bodies.find((b) => b.stream === true)!;
    expect(streamed.model).toBe("mock/model-key"); // the key, not an instance id
    expect(streamed.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Describe this image" },
    ]);
    expect(streamed.max_tokens).toBe(100);
    expect(streamed.ttl).toBe(45);
    expect(streamed.temperature).toBe(0.3);
    expect(streamed.reasoning).toBe("on");
    expect(streamed.stream_options).toEqual({ include_usage: true }); // usage chunk otherwise omitted
    expect(streamed.integrations).toBeUndefined();
    expect(streamed.max_output_tokens).toBeUndefined();
    expect(streamed.input).toBeUndefined();
  });
});
