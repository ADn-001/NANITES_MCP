/**
 * Server-Sent Events writer.
 *
 * ONE writer, shared by both inbound dialects and (in R5b) the async job
 * progress stream. It is a general abstraction rather than an
 * Anthropic-specific one precisely so R5b does not have to build a second one.
 *
 * Two things here are easy to get wrong and expensive when they are:
 *
 *  - **Client disconnect must abort the upstream call.** A harness that hangs
 *    up mid-generation must not leave the provider burning the user's credits
 *    on output nobody receives. `onClose` is the hook; every streaming handler
 *    wires it to its AbortController.
 *  - **Every stream must terminate.** A stream that ends without its dialect's
 *    terminator leaves the client waiting forever. `endAll()` is what closes
 *    any blocks the encoder forgot, so no path can emit an unterminated stream.
 */
import type { ServerResponse } from "node:http";

export interface SseWriter {
  /** Emit a named event with a JSON payload. */
  event(name: string, data: unknown): Promise<void>;
  /** Emit a bare `data:` frame — the OpenAI dialect's chunk shape. */
  data(payload: unknown): Promise<void>;
  /**
   * Emit a verbatim `data:` frame with NO JSON encoding.
   *
   * `[DONE]` is a bare token, not a JSON value. Passing it through `data()`
   * produced `data: "[DONE]"` — quoted — and every OpenAI SDK waits forever for
   * an unquoted terminator. This exists so that mistake cannot be repeated.
   */
  rawData(text: string): Promise<void>;
  /** Terminator. Idempotent; safe to call from a finally block. */
  close(): Promise<void>;
  readonly closed: boolean;
  /** Frames written so far. For assertions; not used in production paths. */
  readonly frameCount: number;
}

export interface SseWriterOptions {
  res: ServerResponse;
  /** Fires once when the client goes away, so the caller can abort upstream. */
  onClose?: () => void;
  /** Optional periodic keepalive, in ms. 0 disables. */
  pingIntervalMs?: number;
  /** Injectable clock, so the ping cadence is testable without waiting 30s. */
  now?: () => number;
}

export function createSseWriter(opts: SseWriterOptions): SseWriter {
  const { res, onClose, pingIntervalMs = 0 } = opts;
  let closed = false;
  let frames = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let clientGone = false;

  const stopPing = (): void => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  // `close` on the response fires for both a clean end and a client abort;
  // `error` covers a broken pipe mid-write. The handler is idempotent so the
  // upstream abort is requested exactly once.
  const onClientGone = (): void => {
    if (clientGone) return;
    clientGone = true;
    closed = true;
    stopPing();
    onClose?.();
  };
  res.once("close", onClientGone);
  res.once("error", onClientGone);

  const write = async (chunk: string): Promise<void> => {
    if (closed || clientGone) return;
    // res.write returning false means the socket buffer is full. There is no
    // reason to await drain in this server — a slow client gets the backpressure
    // for free from the socket, and awaiting would stall the provider stream.
    frames += 1;
    res.write(chunk);
  };

  if (pingIntervalMs > 0) {
    pingTimer = setInterval(() => {
      if (!closed && !clientGone) void write(": ping\n\n");
    }, pingIntervalMs);
    // Never hold the process open for a keepalive.
    pingTimer.unref?.();
  }

  return {
    get closed() {
      return closed;
    },
    get frameCount() {
      return frames;
    },
    async event(name: string, payload: unknown) {
      await write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    async data(payload: unknown) {
      await write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    async rawData(text: string) {
      await write(`data: ${text}\n\n`);
    },
    async close() {
      if (closed) return;
      closed = true;
      stopPing();
      res.removeListener("close", onClientGone);
      res.removeListener("error", onClientGone);
      if (!res.writableEnded) res.end();
    },
  };
}
