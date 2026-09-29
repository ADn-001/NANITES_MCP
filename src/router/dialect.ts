/**
 * Dialect detection and native error shapes.
 *
 * A client parses errors with the same parser it uses for successes, so an
 * OpenAI SDK handed an Anthropic-shaped error reports a confusing parse failure
 * rather than the real problem. Every error the router emits therefore goes
 * through here, shaped for whichever dialect the caller spoke.
 */

export type Dialect = "anthropic" | "openai";

/**
 * Anthropic clients always send `anthropic-version`; OpenAI clients never do.
 * Presence of the header is the signal — it is the one field that reliably
 * distinguishes the two shapes without guessing from the body.
 */
export function detectDialect(headers: Record<string, string | string[] | undefined>): Dialect {
  const raw = headers["anthropic-version"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && value.trim().length > 0) return "anthropic";
  return "openai";
}

export interface RouterErrorBody {
  status: number;
  code: string;
  message: string;
  /** The serialized envelope, already shaped for the caller's dialect. */
  body: unknown;
}

/** OpenAI-shaped error envelope. */
export function openaiError(status: number, code: string, message: string): RouterErrorBody {
  return {
    status,
    code,
    message,
    body: {
      error: {
        message,
        type: code,
        code,
        param: null,
      },
    },
  };
}

/** Anthropic-shaped error envelope. */
export function anthropicError(status: number, code: string, message: string): RouterErrorBody {
  return {
    status,
    code,
    message,
    body: {
      type: "error",
      error: {
        type: anthropicErrorType(code),
        message,
      },
    },
  };
}

/**
 * Map a router error code to Anthropic's error `type` vocabulary. The spec
 * only sanctions a handful, so everything else collapses to `api_error` rather
 * than inventing a value the client may not recognise.
 */
function anthropicErrorType(code: string): string {
  switch (code) {
    case "router_unauthorized":
      return "authentication_error";
    case "router_invalid_request":
      return "invalid_request_error";
    case "modality_unsupported":
    case "chain_exhausted":
      return "not_found_error";
    case "provider_rate_limited":
      return "rate_limit_error";
    case "provider_server_error":
    case "provider_gateway_error":
      return "api_error";
    case "provider_timeout":
      return "request_timeout";
    default:
      return "api_error";
  }
}

export function errorFor(dialect: Dialect, status: number, code: string, message: string): RouterErrorBody {
  return dialect === "anthropic" ? anthropicError(status, code, message) : openaiError(status, code, message);
}
