/**
 * NanitesTransport is the seam between tool logic and the wire protocol.
 *
 * v1 ships only a stdio implementation backed by the MCP SDK. v2 may add an
 * HTTP/SSE transport without touching tool logic: every tool handler is
 * registered against this interface, never against transport-specific code.
 */
export interface NanitesTransport {
  /** Start serving requests. Rejects on binding failure. */
  start(): Promise<void>;
  /** Stop serving requests and release any held resources. */
  stop(): Promise<void>;
  /** Human-readable transport kind, e.g. "stdio" or "http". */
  readonly kind: string;
}
