/**
 * Phase 52 gate — router fallback and error classification.
 *
 * Two audit findings are closed here:
 *
 * 1. **One bad model aborted the whole chain.** Any non-retryable error threw
 *    immediately, even when the failure was specific to the model that had just
 *    been tried and other registered models were fine.
 * 2. **The round-robin key index never advanced on failure** and started at `0`
 *    rather than `-1`, so a fresh profile skipped `keys[0]` on its first call
 *    and every retry of a rate-limited key hit that same key again.
 *
 * Plus the classification gaps found by live measurement:
 * Cloudflare reports "no such model" as HTTP 400 + code 5007, and spent daily
 * quota as HTTP 429 + code 4006 — the same status as rate limiting.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { routeCloudWithRetry } from "../../src/providers/router.js";
import { mapHttpStatus, PROVIDER_ERROR_CODES } from "../../src/providers/errors.js";
import { scratchHome } from "../phase3/helpers.js";

const CF = "cloudflare";

interface Call {
  model: string;
  key: string;
  account: string;
}

/** Scripted fetch: each entry answers one request in order. */
function stubFetch(
  script: Array<{ status: number; body: unknown } | { ok: true; body?: unknown }>,
  calls: Call[],
): () => void {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    const url = String(_url);
    calls.push({
      model: String(body.model),
      key: String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", ""),
      account: url.match(/accounts\/([^/]+)/)?.[1] ?? "",
    });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step && "ok" in step) {
      // `body` is present only when the test needs a 200 that is NOT a good
      // answer — e.g. empty content with a `length` finish reason.
      const payload = step.body ?? {
        id: "req-1",
        choices: [{ message: { role: "assistant", content: "answered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => payload,
        text: async () => "",
      } as unknown as Response;
    }
    const s = step as { status: number; body: unknown };
    return {
      ok: false,
      status: s.status,
      headers: new Headers(),
      json: async () => s.body,
      text: async () => JSON.stringify(s.body),
    } as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function cfError(status: number, code: number, message: string): { status: number; body: unknown } {
  return { status, body: { success: false, errors: [{ code, message }], result: {}, messages: [] } };
}

function harness(name: string, keys: number, models: string[]): ToolDeps {
  const d = buildDeps(scratchHome());
  d.profiles.createProfile({ name });
  d.profiles.switchProfile(name);
  const ks = new ProviderKeyStore(d.db);
  for (let i = 0; i < keys; i += 1) ks.addKey(name, CF, `sk-key-${i}`, { accountId: `acct-${i}` });
  const ms = new ProviderModelStore(d.db);
  for (const m of models) {
    ms.registerManifestModel(name, CF, { model_id: m, context_length: null, vision: false, function_calling: true });
  }
  return d;
}

function opts(d: ToolDeps, profile: string) {
  return {
    profile: d.profiles.getProfile(profile)!,
    db: d.db as DatabaseSync,
    effort: "medium" as const,
    role: "reviewer",
    brief: "review this",
    messages: [{ role: "user" as const, content: "hi" }],
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const MODEL_A = "@cf/ibm-granite/granite-4.0-h-micro";
const MODEL_B = "@cf/zai-org/glm-4.7-flash";

describe("phase52 — one bad model does not abort the chain", () => {
  it("walks to the second model when the first is unknown (400 + code 5007)", async () => {
    const d = harness("ph52-model-fallback", 1, [MODEL_A, MODEL_B]);
    const calls: Call[] = [];
    restore = stubFetch([cfError(400, 5007, "no such model"), { ok: true }], calls);

    const res = await routeCloudWithRetry(opts(d, "ph52-model-fallback"), CF, undefined);

    expect(res.model_id).toBe(MODEL_B);
    expect(calls.map((c) => c.model)).toEqual([MODEL_A, MODEL_B]);
  });

  it("walks on when a model cannot answer at all (budget exhausted)", async () => {
    const d = harness("ph52-budget-fallback", 1, [MODEL_A, MODEL_B]);
    const calls: Call[] = [];
    // Empty content with no tool calls, twice (the doubled-budget retry), then a
    // healthy answer from the next model.
    const empty = {
      ok: true as const,
      body: { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: {} },
    };
    restore = stubFetch([empty, empty, { ok: true }], calls);

    const res = await routeCloudWithRetry(opts(d, "ph52-budget-fallback"), CF, undefined);

    expect(res.model_id).toBe(MODEL_B);
  });

  it("stops the provider when the only key is rejected (401)", async () => {
    const d = harness("ph52-auth-stop", 1, [MODEL_A, MODEL_B]);
    const calls: Call[] = [];
    restore = stubFetch([cfError(401, 0, "auth failure")], calls);

    await expect(routeCloudWithRetry(opts(d, "ph52-auth-stop"), CF, undefined)).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.AUTH,
    });
    // The chain died on the first model rather than working through the rest.
    expect(calls).toHaveLength(1);
  });

  it("rotates past a rejected key instead of abandoning the provider", async () => {
    const d = harness("ph52-key-rotate-auth", 2, [MODEL_A]);
    const calls: Call[] = [];
    restore = stubFetch([cfError(401, 0, "auth failure"), { ok: true }], calls);

    const res = await routeCloudWithRetry(opts(d, "ph52-key-rotate-auth"), CF, undefined);

    expect(res.model_id).toBe(MODEL_A);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).not.toBe(calls[1]!.key);
  });
});

describe("phase52 — quota exhaustion is not rate limiting", () => {
  it("maps 429 + 4006 to a non-retryable quota error", () => {
    const err = mapHttpStatus(429, { success: false, errors: [{ code: 4006, message: "used up your daily free allocation" }] }, CF);
    expect(err.code).toBe(PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED);
    expect(err.retryable).toBe(false);
  });

  it("still maps 429 + 6293 to a retryable rate limit", () => {
    const err = mapHttpStatus(429, { success: false, errors: [{ code: 6293, message: "rate limited" }] }, CF);
    expect(err.code).toBe(PROVIDER_ERROR_CODES.RATE_LIMITED);
    expect(err.retryable).toBe(true);
  });

  it("maps 400 + 5007 to model-not-found, since CF does not use 404 here", () => {
    const err = mapHttpStatus(400, { success: false, errors: [{ code: 5007, message: "no such model" }] }, CF);
    expect(err.code).toBe(PROVIDER_ERROR_CODES.MODEL_NOT_FOUND);
    expect(err.details?.provider_error_code).toBe("5007");
  });

  it("maps 403 + 5016 to the model license agreement, not a generic forbidden", () => {
    const err = mapHttpStatus(403, { success: false, errors: [{ code: 5016, message: "Model Agreement" }] }, CF);
    expect(err.code).toBe(PROVIDER_ERROR_CODES.AGREEMENT_REQUIRED);
    expect(err.retryable).toBe(false);
  });

  it("retires a quota-exhausted key and completes on the next account", async () => {
    const d = harness("ph52-quota-rotate", 2, [MODEL_A]);
    const calls: Call[] = [];
    restore = stubFetch([cfError(429, 4006, "daily allocation spent"), { ok: true }], calls);

    const res = await routeCloudWithRetry(opts(d, "ph52-quota-rotate"), CF, undefined);
    expect(res.model_id).toBe(MODEL_A);

    // The spent key is out of the pool until the allowance resets.
    const keys = new ProviderKeyStore(d.db).availableKeys("ph52-quota-rotate", CF);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.key_id).not.toBe(new ProviderKeyStore(d.db).listKeys("ph52-quota-rotate", CF)[0]!.key_id);
  });
});

describe("phase52 — retryable classification", () => {
  it("treats 524, 529 and 500 as retryable", () => {
    expect(mapHttpStatus(524, {}, CF).retryable).toBe(true);
    expect(mapHttpStatus(529, {}, CF).retryable).toBe(true);
    expect(mapHttpStatus(500, {}, CF).retryable).toBe(true);
  });

  it("treats 402 and 403 as non-retryable", () => {
    expect(mapHttpStatus(402, {}, CF).retryable).toBe(false);
    expect(mapHttpStatus(403, {}, CF).retryable).toBe(false);
  });

  it("retries a transient 503 and succeeds on the second attempt", async () => {
    const d = harness("ph52-retry-transient", 1, [MODEL_A]);
    const calls: Call[] = [];
    restore = stubFetch([cfError(503, 9999, "temporarily unavailable"), { ok: true }], calls);

    const res = await routeCloudWithRetry(opts(d, "ph52-retry-transient"), CF, undefined);

    expect(res.model_id).toBe(MODEL_A);
    expect(calls).toHaveLength(2);
  }, 20_000);
});

describe("phase52 — round-robin key index", () => {
  it("uses keys[0] on the very first call of a fresh profile", async () => {
    const d = harness("ph52-first-key", 2, [MODEL_A]);
    const calls: Call[] = [];
    restore = stubFetch([{ ok: true }], calls);

    await routeCloudWithRetry(opts(d, "ph52-first-key"), CF, undefined);

    const keys = new ProviderKeyStore(d.db).listKeys("ph52-first-key", CF);
    expect(calls[0]!.key).toBe(keys[0]!.api_key);
  });

  it("advances the persisted cursor past a key that failed", async () => {
    const d = harness("ph52-cursor-advance", 3, [MODEL_A]);
    const calls: Call[] = [];
    // 503 is retryable, so this exercises the failure path rather than the
    // key-scoped rotation above.
    restore = stubFetch([cfError(503, 9999, "unavailable"), { ok: true }], calls);

    await routeCloudWithRetry(opts(d, "ph52-cursor-advance"), CF, undefined);

    const keys = new ProviderKeyStore(d.db).listKeys("ph52-cursor-advance", CF);
    const second = keys.find((k) => k.api_key === calls[1]!.key)!;
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    expect(new ProviderKeyStore(d.db).getKeyState("ph52-cursor-advance", CF).lastKeyIndex).toBe(
      keys.indexOf(second),
    );
  });
});
