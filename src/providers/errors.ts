/**
 * Provider error normalization. Each cloud provider returns errors in a distinct
 * shape; this module maps them to unified NanitesError codes so the router treats
 * all providers uniformly.
 */
import { NanitesError } from "../helpers/errors.js";
import type { ProviderKind } from "../storage/profileDefaults.js";

export const PROVIDER_ERROR_CODES = {
  AUTH: "provider_auth_error",
  INSUFFICIENT_CREDITS: "provider_insufficient_credits",
  FORBIDDEN: "provider_forbidden",
  MODEL_NOT_FOUND: "provider_model_not_found",
  RATE_LIMITED: "provider_rate_limited",
  SERVER_ERROR: "provider_server_error",
  GATEWAY_ERROR: "provider_gateway_error",
  TIMEOUT: "provider_timeout",
  NETWORK_ERROR: "provider_network_error",
  UNAVAILABLE: "provider_unavailable",
  /** The model returned nothing usable — empty content, no tool calls — even
   * after a doubled budget. Distinct from a transport failure: the request
   * succeeded and the provider billed it. */
  BUDGET_EXHAUSTED: "provider_budget_exhausted",
  /** The account has spent its metered allowance and cannot serve requests
   * until it resets. Arrives as HTTP 429 — the same status as rate limiting —
   * so it is only distinguishable by the provider error code (Cloudflare
   * `4006`). Non-retryable within the run: retrying burns the remaining
   * attempts on a call that cannot succeed today. */
  QUOTA_EXHAUSTED: "provider_quota_exhausted",
  /** The provider requires a one-time license agreement before this model will
   * serve. Cloudflare returns HTTP 403 with code `5016` until the account
   * submits the literal prompt `agree`. Model-scoped and non-retryable — it
   * needs a human, not another attempt. */
  AGREEMENT_REQUIRED: "provider_model_agreement_required",
} as const;

/** Codes that blame the KEY rather than the model. The router retires that key
 * and rotates to the next one; the chain only dies when no usable key is left.
 * Treating these as immediately provider-fatal would abandon a provider that
 * still had a working key in reserve. */
export const KEY_SCOPED_CODES: ReadonlySet<string> = new Set<string>([
  PROVIDER_ERROR_CODES.AUTH,
  PROVIDER_ERROR_CODES.INSUFFICIENT_CREDITS,
  PROVIDER_ERROR_CODES.FORBIDDEN,
  PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED,
]);

/** Codes that blame the MODEL. The router records the failure and walks on to
 * the next model instead of aborting the run. */
export const MODEL_SCOPED_CODES: ReadonlySet<string> = new Set<string>([
  PROVIDER_ERROR_CODES.MODEL_NOT_FOUND,
  PROVIDER_ERROR_CODES.AGREEMENT_REQUIRED,
  // One model returning nothing at double budget says nothing about the next.
  PROVIDER_ERROR_CODES.BUDGET_EXHAUSTED,
]);

export function isKeyScoped(code: string): boolean {
  return KEY_SCOPED_CODES.has(code);
}

export function isModelScoped(code: string): boolean {
  return MODEL_SCOPED_CODES.has(code);
}

export type ProviderErrorCode =
  | typeof PROVIDER_ERROR_CODES[keyof typeof PROVIDER_ERROR_CODES]
  | "all_keys_exhausted"
  | "all_models_exhausted"
  | "provider_disabled"
  | "generic_discovery_failed";

export interface ProviderApiError {
  code: ProviderErrorCode;
  message: string;
  httpStatus?: number;
  providerErrorCode?: string;
  retryable: boolean;
}

interface CloudflareErrorDetail { code: number; message: string }
interface CloudflareErrorResponse { success: false; errors: CloudflareErrorDetail[]; messages?: string[] }

interface OpenRouterErrorResponse { error: { code?: string; message: string; metadata?: Record<string, unknown> } }

interface OmniRouteErrorResponse { error: { code: string; message: string; type?: string; provider?: string } }

const MAX_MESSAGE = 400;

/** Best-effort extraction of a string error from an unknown body. */
function extractMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, MAX_MESSAGE);
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    // OpenAI-compatible `{ error: { message, code, metadata } }` — OpenRouter
    // wraps upstream rate-limit detail in error.metadata.raw, which reads far
    // better than the generic "Provider returned error" headline.
    if (o.error && typeof o.error === "object") {
      const err = o.error as Record<string, unknown>;
      if (typeof err.metadata === "object" && err.metadata && typeof (err.metadata as Record<string, unknown>).raw === "string") {
        return ((err.metadata as Record<string, unknown>).raw as string).slice(0, MAX_MESSAGE);
      }
      if (typeof err.message === "string") return err.message.slice(0, MAX_MESSAGE);
    }
    if (typeof o.message === "string") return o.message.slice(0, MAX_MESSAGE);
    if (typeof o.error === "string") return o.error.slice(0, MAX_MESSAGE);
    if (Array.isArray(o.errors)) {
      const first = (o.errors as unknown[])[0];
      if (first && typeof first === "object") {
        const msg = (first as Record<string, unknown>).message;
        if (typeof msg === "string") return msg.slice(0, MAX_MESSAGE);
      }
    }
  }
  return "unknown provider error";
}

/** Map a fetch NetworkError / AbortError to a structured error. */
export function mapFetchError(err: unknown): NanitesError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("abort") || msg.includes("AbortError")) {
    return new NanitesError({ code: PROVIDER_ERROR_CODES.TIMEOUT, message: "provider request timed out", retryable: true });
  }
  // Never echo the raw message: a fetch failure embeds the full resolved
  // URL, which on the Cloudflare path carries the account id.
  return new NanitesError({
    code: PROVIDER_ERROR_CODES.NETWORK_ERROR,
    message: "could not reach the provider",
    retryable: true,
  });
}

/** Map HTTP status to a structured error. */
export function mapHttpStatus(status: number, body: unknown, provider?: ProviderKind): NanitesError {
  let code: ProviderErrorCode = PROVIDER_ERROR_CODES.SERVER_ERROR;
  let retryable = false;
  let providerErrorCode: string | undefined;

  if (status === 401) { code = PROVIDER_ERROR_CODES.AUTH; retryable = false; }
  else if (status === 402) { code = PROVIDER_ERROR_CODES.INSUFFICIENT_CREDITS; retryable = false; }
  else if (status === 403) { code = PROVIDER_ERROR_CODES.FORBIDDEN; retryable = false; }
  else if (status === 404) { code = PROVIDER_ERROR_CODES.MODEL_NOT_FOUND; retryable = false; }
  else if (status === 408) { code = PROVIDER_ERROR_CODES.TIMEOUT; retryable = true; }
  // 429 is ambiguous: rate limiting and spent quota share the status. The
  // provider code below is what actually decides.
  else if (status === 429) { code = PROVIDER_ERROR_CODES.RATE_LIMITED; retryable = true; }
  else if (status === 500) { code = PROVIDER_ERROR_CODES.SERVER_ERROR; retryable = true; }
  else if (status === 502 || status === 503) { code = PROVIDER_ERROR_CODES.GATEWAY_ERROR; retryable = true; }
  else if (status === 524) { code = PROVIDER_ERROR_CODES.TIMEOUT; retryable = true; }
  else if (status === 529) { code = PROVIDER_ERROR_CODES.UNAVAILABLE; retryable = true; }
  else if (status >= 500) { code = PROVIDER_ERROR_CODES.SERVER_ERROR; retryable = true; }

  // Try provider-specific body parsing
  if (body && typeof body === "object") {
    if (provider === "cloudflare") {
      const cf = body as CloudflareErrorResponse;
      if (!cf.success && Array.isArray(cf.errors) && cf.errors.length > 0) {
        const first = cf.errors[0];
        if (first) {
          providerErrorCode = String(first.code);
          // Cloudflare's numeric codes override the status, because the status
          // is not discriminating enough. Measured live 2026-09-10:
          //   6293 rate limit                     -> HTTP 429
          //   4006 daily neuron quota spent       -> HTTP 429 (same as above!)
          //   5007 no such model                  -> HTTP 400 (not 404!)
          //   5016 model license not accepted     -> HTTP 403
          //   0    auth failure                   -> HTTP 401
          if (first.code === 6293) { code = PROVIDER_ERROR_CODES.RATE_LIMITED; retryable = true; }
          else if (first.code === 4006) { code = PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED; retryable = false; }
          else if (first.code === 5007) { code = PROVIDER_ERROR_CODES.MODEL_NOT_FOUND; retryable = false; }
          else if (first.code === 5016) { code = PROVIDER_ERROR_CODES.AGREEMENT_REQUIRED; retryable = false; }
          else if (first.code === 0) { code = PROVIDER_ERROR_CODES.AUTH; retryable = false; }
        }
      }
    } else if (provider === "openrouter") {
      const or = body as OpenRouterErrorResponse;
      const orCode = or.error?.code !== undefined ? String(or.error.code) : undefined;
      if (orCode) {
        providerErrorCode = orCode;
        if (orCode === "insufficient_quota" || orCode === "402") {
          code = PROVIDER_ERROR_CODES.INSUFFICIENT_CREDITS; retryable = false;
        } else if (orCode === "rate_limit_exceeded" || orCode === "429") {
          code = PROVIDER_ERROR_CODES.RATE_LIMITED; retryable = true;
        } else if (orCode === "invalid_api_key" || orCode === "401") {
          code = PROVIDER_ERROR_CODES.AUTH; retryable = false;
        }
      }
    } else if (provider === "omniroute") {
      const om = body as OmniRouteErrorResponse;
      if (om.error?.code) {
        providerErrorCode = om.error.code;
        if (om.error.code === "provider_rate_limit" || om.error.code === "rate_limit") {
          code = PROVIDER_ERROR_CODES.RATE_LIMITED; retryable = true;
        } else if (om.error.code === "invalid_key" || om.error.code === "unauthorized") {
          code = PROVIDER_ERROR_CODES.AUTH; retryable = false;
        }
      }
    }
  }

  return new NanitesError({
    code,
    message: extractMessage(body),
    retryable,
    details: status !== undefined ? { http_status: status, provider_error_code: providerErrorCode } : undefined,
  });
}
