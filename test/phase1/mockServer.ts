import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockLmStudio {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Number of requests received — for call-count assertions. */
  requestCount(): number;
}

export type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>;

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export function sendText(res: http.ServerResponse, status: number, text: string, contentType = "text/plain"): void {
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Serve a /api/v1/chat response as an LM Studio-style SSE stream (the shape
 * real LM Studio emits when `stream: true`), terminating in `chat.end` whose
 * `result` is the aggregated response object the streaming reassembler parses.
 */
export function sendChatStream(res: http.ServerResponse, response: Record<string, unknown>): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const event = (type: string, data: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  event("chat.start", {});
  event("message.start", { role: "assistant" });
  const text = (response.output as Array<{ type?: string; content?: string }> | undefined)
    ?.filter((o) => o.type === "message")
    .map((o) => o.content ?? "")
    .join("\n");
  if (text) event("message.delta", { content: text });
  event("message.end", {});
  event("chat.end", { result: response });
  res.end();
}

/**
 * Serve a `/v1/chat/completions` (OpenAI-compat) response as SSE: a role chunk,
 * one content delta, a final chunk carrying `usage`, then `data: [DONE]`.
 * Mirrors the real wire the TTL transport parses (no `event:` lines, `\n\n`
 * delimiters, [DONE] terminator).
 */
export function sendOpenAiChatStream(
  res: http.ServerResponse,
  content: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } = { prompt_tokens: 42, completion_tokens: 9 },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const chunk = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const id = "chatcmpl-mock";
  chunk({ id, object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  if (content) {
    chunk({ id, object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  }
  chunk({ id, object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

/** True when a parsed /api/v1/chat request body asked for a streaming reply. */
export function wantsStream(body: string): boolean {
  try {
    return JSON.parse(body).stream === true;
  } catch {
    return false;
  }
}

/** Type of the emitter returned by `openChatStream`. */
export type SseEmitter = (type: string, data: unknown) => void;

/**
 * Write the SSE response head for a `/api/v1/chat` stream and return an emitter
 * the caller can fire events on over time (for idle-timeout tests that need a
 * slow-but-alive or stalled stream rather than one giant synchronous flush).
 * The caller owns ending the response (`chat.end` + `res.end()`).
 */
export function openChatStream(res: http.ServerResponse): SseEmitter {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return (type: string, data: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/**
 * Start a mock LM Studio HTTP server. The handler is responsible for routing
 * by method + URL and calling sendJson/sendText. Request bodies are read and
 * passed through for assertion.
 */
export async function startMockLmStudio(handler: MockHandler): Promise<MockLmStudio> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      Promise.resolve(handler(req, res, raw)).catch((err: unknown) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`mock handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requestCount: () => count,
  };
}
