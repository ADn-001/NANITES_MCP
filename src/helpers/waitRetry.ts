/**
 * Wait-for-reply-with-timeout + retry policy.
 *
 * The timeout is enforced by the underlying call (AbortSignal.timeout in
 * LmStudioClient); this layer wraps the call, retries only on retryable
 * errors with exponential backoff, and surfaces a distinct error once
 * retries are exhausted.
 */
import { NanitesError } from "./errors.js";

export interface WaitRetryConfig {
  /** Per-attempt timeout, applied by the caller. Default 30s. */
  timeoutMs?: number;
  /** Number of retries AFTER the first attempt. Default 2. */
  retries?: number;
  /** Base backoff delay in ms; each retry doubles it. Default 500. */
  baseDelayMs?: number;
}

export interface WaitRetryResult<T> {
  value?: T;
  attempts: number;
}

const DEFAULT: Required<WaitRetryConfig> = { timeoutMs: 30_000, retries: 2, baseDelayMs: 500 };

export async function waitForReply<T>(
  call: () => Promise<T>,
  config: WaitRetryConfig = {},
): Promise<WaitRetryResult<T>> {
  const cfg = { ...DEFAULT, ...config };
  let attempts = 0;
  let lastError: unknown;

  for (;;) {
    attempts++;
    try {
      const value = await call();
      return { value, attempts };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof NanitesError && err.retryable;
      if (!retryable) throw err;
      if (attempts > cfg.retries) {
        throw new NanitesError({
          code: "retries_exhausted",
          message: `call failed after ${attempts} attempt(s)`,
          retryable: false,
          details: { attempts, cause: err instanceof NanitesError ? err.toShape() : String(err) },
        });
      }
      const delay = cfg.baseDelayMs * 2 ** (attempts - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
