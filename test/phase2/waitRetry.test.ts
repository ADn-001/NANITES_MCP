import { describe, expect, it } from "vitest";
import { waitForReply } from "../../src/helpers/waitRetry.js";
import { NanitesError } from "../../src/helpers/errors.js";

function retryableError(code: string): NanitesError {
  return new NanitesError({ code, message: code, retryable: true });
}

describe("waitForReply — timeout + retry policy", () => {
  it("kills a hung call at the configured timeout (not before or meaningfully after)", async () => {
    const timeoutMs = 200;
    // Models the real stack: the client enforces the timeout (AbortSignal),
    // so the call rejects with a timeout error at ~timeoutMs, not later.
    const call = async (): Promise<never> => {
      await new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(retryableError("timeout")), timeoutMs);
      });
      throw retryableError("timeout");
    };

    const start = Date.now();
    await expect(waitForReply(call, { timeoutMs, retries: 0, baseDelayMs: 0 })).rejects.toMatchObject({
      code: "retries_exhausted",
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
    expect(elapsed).toBeLessThan(timeoutMs + 300);
  });

  it("fires retries the documented number of times before final failure", async () => {
    let calls = 0;
    const call = async (): Promise<never> => {
      calls++;
      throw retryableError("timeout");
    };

    await expect(waitForReply(call, { timeoutMs: 50, retries: 2, baseDelayMs: 1 })).rejects.toMatchObject({
      code: "retries_exhausted",
      details: { attempts: 3 },
    });
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("does not retry a non-retryable error — surfaces the original", async () => {
    let calls = 0;
    const call = async (): Promise<never> => {
      calls++;
      throw new NanitesError({ code: "malformed_json", message: "bad", retryable: false });
    };

    await expect(waitForReply(call, { retries: 3 })).rejects.toMatchObject({ code: "malformed_json" });
    expect(calls).toBe(1);
  });

  it("returns the value on first success", async () => {
    const result = await waitForReply(async () => 42, { retries: 3 });
    expect(result.value).toBe(42);
    expect(result.attempts).toBe(1);
  });

  it("succeeds after a transient failure", async () => {
    let calls = 0;
    const call = async (): Promise<string> => {
      calls++;
      if (calls === 1) throw retryableError("timeout");
      return "ok";
    };
    const result = await waitForReply(call, { timeoutMs: 50, retries: 2, baseDelayMs: 1 });
    expect(result.value).toBe("ok");
    expect(calls).toBe(2);
  });
});
