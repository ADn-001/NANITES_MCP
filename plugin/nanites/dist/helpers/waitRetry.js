/**
 * Wait-for-reply-with-timeout + retry policy.
 *
 * The timeout is enforced by the underlying call (AbortSignal.timeout in
 * LmStudioClient); this layer wraps the call, retries only on retryable
 * errors with exponential backoff, and surfaces a distinct error once
 * retries are exhausted.
 */
import { NanitesError } from "./errors.js";
const DEFAULT = { timeoutMs: 30_000, retries: 2, baseDelayMs: 500 };
export async function waitForReply(call, config = {}) {
    const cfg = { ...DEFAULT, ...config };
    let attempts = 0;
    let lastError;
    for (;;) {
        attempts++;
        try {
            const value = await call();
            return { value, attempts };
        }
        catch (err) {
            lastError = err;
            const retryable = err instanceof NanitesError && err.retryable;
            if (!retryable)
                throw err;
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
