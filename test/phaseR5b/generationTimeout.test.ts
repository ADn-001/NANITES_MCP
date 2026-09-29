/**
 * R5b — generation timeout hardening.
 *
 * The phase this replaced (an async job API: submit, poll, SSE progress,
 * restart recovery, cancellation) was scoped against an assumption the live
 * probe disproved. Measured over 3 runs each against a real key:
 *
 *   FLUX 4-step            1.4s avg /  1.7s max
 *   Aura TTS short         0.6s avg /  0.8s max
 *   Aura TTS long          2.2s avg /  2.4s max
 *   MeloTTS long           5.8s avg /  5.9s max
 *   SDXL Base 20-step 1k   69.6s avg / 83.4s max   <- the only slow one
 *
 * 83s fits the 240s ceiling with 2.9x headroom and well inside Claude Code's
 * own 600s default. A 1.2MB image taking 83 seconds is not a hanging
 * connection, so a job queue would be infrastructure built for a case that
 * already works.
 *
 * What is actually worth hardening is the ONE slow case, and the fact that a
 * client which disconnects mid-render still costs the full render.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { ROUTER_PROFILE } from "../../src/router/constants.js";
import {
  resolveTimeout,
  DEFAULT_GENERATION_TIMEOUT_MS,
  MAX_GENERATION_TIMEOUT_MS,
} from "../../src/router/outbound/cloudflareRun.js";
import { decodeOpenAiRequest } from "../../src/router/inbound/openai.js";
import { decodeAnthropicRequest } from "../../src/router/inbound/anthropic.js";
import type { IRRequest } from "../../src/router/ir/types.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];
let restoreFetch: (() => void) | null = null;

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function baseReq(over: Partial<IRRequest> = {}): IRRequest {
  return { model: "m", messages: [{ role: "user", content: "a red cube" }], max_output_tokens: 100, stream: false, ...over };
}

function stubCloudflare(handler: (init?: RequestInit) => Response | Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("127.0.0.1") || href.includes("localhost")) return original(url as string, init);
    return handler(init);
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; restoreFetch = null; };
}

async function harness() {
  const h = scratchHome();
  homes.push(h);
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  new ProviderKeyStore(handle.deps.db).addKey(ROUTER_PROFILE, "cloudflare", "cf-token", { accountId: "acct" });
  new ProviderModelStore(handle.deps.db)
    .registerModel(ROUTER_PROFILE, "cloudflare", "@cf/black-forest-labs/flux-1-schnell");
  const key = handle.deps.generatedKey!;
  return {
    handle, key,
    post: (body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }),
  };
}

afterEach(async () => {
  restoreFetch?.();
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

describe("resolveTimeout", () => {
  it("defaults to the measured ceiling", () => {
    expect(resolveTimeout(baseReq())).toBe(DEFAULT_GENERATION_TIMEOUT_MS);
    // 240s, which is 2.9x the slowest model measured live.
    expect(DEFAULT_GENERATION_TIMEOUT_MS).toBe(240_000);
  });

  it("honours a caller-declared budget", () => {
    expect(resolveTimeout(baseReq(), 500_000)).toBe(500_000);
  });

  it("reads a budget declared on the request body", () => {
    const decoded = decodeOpenAiRequest({
      model: "m", messages: [{ role: "user", content: "x" }], timeout_ms: 420_000,
    });
    expect((decoded as { timeout_ms?: number }).timeout_ms).toBe(420_000);
    expect(resolveTimeout(decoded)).toBe(420_000);
  });

  it("accepts it on the Anthropic dialect too", () => {
    const decoded = decodeAnthropicRequest({
      model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }], timeout_ms: 300_000,
    });
    expect((decoded as { timeout_ms?: number }).timeout_ms).toBe(300_000);
  });

  it("CLAMPS to the ceiling rather than trusting the caller", () => {
    // A caller asking for an hour must not pin a worker open for an hour.
    expect(resolveTimeout(baseReq(), 99_999_999)).toBe(MAX_GENERATION_TIMEOUT_MS);
  });

  it("ignores a nonsense budget rather than failing the request", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(resolveTimeout(baseReq(), bad)).toBe(DEFAULT_GENERATION_TIMEOUT_MS);
    }
  });
});

describe("timeout and cancellation over HTTP", () => {
  it("reports a slow generation as a TIMEOUT with actionable advice", async () => {
    const h = await harness();
    stubCloudflare(() => {
      // Reproduce the real AbortError that a budget overrun produces.
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      return Promise.reject(err);
    });

    const res = await h.post({
      model: "cloudflare:@cf/black-forest-labs/flux-1-schnell",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("provider_timeout");
    // A slow model is not a broken one, and the message has to say so.
    expect(body.error.message).toMatch(/slow rather than unavailable/i);
    expect(body.error.message).toMatch(/timeout_ms/);
  });

  it("CANCELS the upstream when the client disconnects", async () => {
    // The measured slow case is ~70s. Without this, a client that hangs up
    // still pays for the whole render.
    const h = await harness();
    let upstreamAborted = false;
    let stubReached = false;

    // The stub receives the RequestInit, so it can watch the ACTUAL signal the
    // router passed. Watching `process` events here was wrong — fetch's signal
    // is not a process-level event, so the test could never have observed the
    // abort it was asserting.
    stubCloudflare((init) => new Promise<Response>((_, reject) => {
      stubReached = true;
      const signal = init?.signal;
      const timer = setTimeout(() => reject(new Error("too slow")), 30_000);
      const onAbort = (): void => {
        clearTimeout(timer);
        upstreamAborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }));

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${h.handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.key}` },
      body: JSON.stringify({
        model: "cloudflare:@cf/black-forest-labs/flux-1-schnell",
        messages: [{ role: "user", content: "x" }],
      }),
      signal: controller.signal,
    }).catch(() => undefined);

    // Wait for the stub to actually be reached, THEN hang up. A fixed short
    // sleep is a race: the request still has to authenticate, resolve the
    // model, and select a key before it reaches the provider, and aborting
    // before that tests nothing.
    const deadline = Date.now() + 5_000;
    while (!stubReached && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stubReached).toBe(true);

    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 100));

    expect(upstreamAborted).toBe(true);
  });

  it("does NOT cancel a client that simply waits", async () => {
    // The positive control for the test above: a server that cancels
    // everything would pass the disconnect case for entirely the wrong reason.
    const h = await harness();
    let completed = false;
    stubCloudflare(() => {
      completed = true;
      return new Response(JSON.stringify({ success: true, result: { image: PNG_B64 } }),
        { headers: { "content-type": "application/json" } });
    });

    const res = await h.post({
      model: "cloudflare:@cf/black-forest-labs/flux-1-schnell",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(200);
    expect(completed).toBe(true);
    const body = (await res.json()) as { data: Array<{ b64_json: string }> };
    expect(body.data[0]!.b64_json).toBe(PNG_B64);
  });
});

describe("why there is no job API", () => {
  it("pins the measured durations this decision rests on", () => {
    // Recorded from a live probe on 2026-09-29, 3 runs each. If a future probe
    // finds a model far outside this range, the job API becomes worth building
    // and this test is the reminder to re-probe.
    const MEASURED_MAX_MS: Record<string, number> = {
      "@cf/black-forest-labs/flux-1-schnell": 1_731,
      "@cf/deepgram/aura-1": 2_356,
      "@cf/myshell-ai/melotts": 5_867,
      "@cf/stabilityai/stable-diffusion-xl-base-1.0": 83_392,
    };
    for (const [model, ms] of Object.entries(MEASURED_MAX_MS)) {
      expect(ms, model).toBeLessThan(DEFAULT_GENERATION_TIMEOUT_MS);
    }
    // The slowest is comfortably inside the ceiling, not scraping it.
    const slowest = Math.max(...Object.values(MEASURED_MAX_MS));
    expect(slowest).toBeLessThan(DEFAULT_GENERATION_TIMEOUT_MS / 2);
  });
});
