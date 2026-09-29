/**
 * Cloudflare `/ai/run` over the real HTTP path.
 *
 * The unit tests in cloudflareRun.test.ts cover body shaping and response
 * decoding. This one covers the ROUTING decision — which of the two Cloudflare
 * endpoints a given model is sent to — because getting that wrong produces a
 * 404 or a shape error that neither unit test can see.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { ROUTER_PROFILE } from "../../src/router/constants.js";
import { needsRunPath } from "../../src/router/outbound/cloudflareRun.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];
let restoreFetch: (() => void) | null = null;

interface Seen { url: string; body: Record<string, unknown> }

// A real PNG header, so the mime sniffer has actual magic bytes to read.
// Four arbitrary bytes are honestly unidentifiable and would be labelled
// application/octet-stream, which is the correct answer for them.
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

/**
 * Stub BOTH Cloudflare endpoints so the routing decision is observable: a call
 * to the chat shim and a call to /ai/run land on different URLs.
 */
function stubCloudflare(seen: Seen[], reply: (url: string) => Response): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("127.0.0.1") || href.includes("localhost")) return original(url as string, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ url: href, body });
    return reply(href);
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; restoreFetch = null; };
}

async function harness(modelIds: string[]) {
  const h = scratchHome();
  homes.push(h);
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);

  new ProviderKeyStore(handle.deps.db).addKey(ROUTER_PROFILE, "cloudflare", "cf-token", {
    accountId: "acct-test",
  });
  const models = new ProviderModelStore(handle.deps.db);
  for (const id of modelIds) models.registerModel(ROUTER_PROFILE, "cloudflare", id);

  const seen: Seen[] = [];
  const post = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.deps.generatedKey}` },
      body: JSON.stringify(body),
    });

  return { handle, seen, post, key: handle.deps.generatedKey! };
}

const OPENAI_SHIM = (text: string): Response =>
  new Response(JSON.stringify({
    id: "u", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { headers: { "content-type": "application/json" } });

afterEach(async () => {
  restoreFetch?.();
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

describe("routing decision", () => {
  it("sends text-generation to the OpenAI-compatible shim, NOT /ai/run", () => {
    // The chat shim is the better-tested path for text, and routing text
    // through /ai/run would return a nested envelope the caller does not
    // expect.
    expect(needsRunPath("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(false);
    expect(needsRunPath("@cf/qwen/qwen3.8-27b")).toBe(false);
  });

  it("sends every non-text category to /ai/run", () => {
    for (const id of [
      "@cf/black-forest-labs/flux-1-schnell",
      "@cf/llava-hf/llava-1.5-7b-hf",
      "@cf/myshell-ai/melotts",
      "@cf/deepgram/aura-1",
      "@cf/runwayml/stable-diffusion-v1-5-img2img",
    ]) {
      expect(needsRunPath(id), id).toBe(true);
    }
  });

  it("sends an UNKNOWN model to the shim rather than guessing", () => {
    // No verified body means no /ai/run. A model outside the registry is
    // treated as text and either works on the shim or fails cleanly there.
    expect(needsRunPath("@cf/some/model-we-never-registered")).toBe(false);
  });
});

describe("over HTTP", () => {
  it("routes an image model to /ai/run and returns the OpenAI image shape", async () => {
    const h = await harness(["@cf/black-forest-labs/flux-1-schnell"]);
    stubCloudflare(h.seen, () =>
      new Response(JSON.stringify({ success: true, result: { image: PNG_B64 } }),
        { headers: { "content-type": "application/json" } }));

    const res = await h.post({
      model: "cloudflare:@cf/black-forest-labs/flux-1-schnell",
      messages: [{ role: "user", content: "a red cube" }],
    });
    expect(res.status).toBe(200);

    // The URL is the observable proof of the routing decision.
    expect(h.seen[0]!.url).toContain("/ai/run/@cf/black-forest-labs/flux-1-schnell");
    expect(h.seen[0]!.url).not.toContain("chat/completions");
    // No unsupported parameter was forwarded.
    expect(h.seen[0]!.body["num_steps"]).toBeUndefined();
    expect(h.seen[0]!.body["prompt"]).toBe("a red cube");

    const body = (await res.json()) as { data: Array<{ b64_json: string; mime_type: string }> };
    expect(body.data[0]!.b64_json).toBe(PNG_B64);
    expect(body.data[0]!.mime_type).toBe("image/png");
  });

  it("routes TTS to /ai/run and returns an audio artifact", async () => {
    const h = await harness(["@cf/myshell-ai/melotts"]);
    stubCloudflare(h.seen, () =>
      new Response(JSON.stringify({ success: true, result: { audio: PNG_B64 } }),
        { headers: { "content-type": "application/json" } }));

    const res = await h.post({
      model: "cloudflare:@cf/myshell-ai/melotts",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);
    expect(h.seen[0]!.url).toContain("/ai/run/");
    // MeloTTS takes `prompt`, not `text` — proven by the live probe.
    expect(h.seen[0]!.body["prompt"]).toBe("hello");
    expect(h.seen[0]!.body["text"]).toBeUndefined();

    const body = (await res.json()) as { data: Array<{ mime_type: string }> };
    expect(body.data[0]!.mime_type).toBe("audio/wav");
  });

  it("routes a VQA model to /ai/run with RAW BYTES, not base64", async () => {
    const h = await harness(["@cf/llava-hf/llava-1.5-7b-hf"]);
    const black = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAXklEQVRoge3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgokAAfJq/HWQAAAABJRU5ErkJggg==";
    stubCloudflare(h.seen, () =>
      new Response(JSON.stringify({ success: true, result: { description: "a black image" } }),
        { headers: { "content-type": "application/json" } }));

    const res = await h.post({
      model: "cloudflare:@cf/llava-hf/llava-1.5-7b-hf",
      messages: [{ role: "user", content: [
        { type: "text", text: "what color" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${black}` } },
      ] }],
    });
    expect(res.status).toBe(200);
    expect(h.seen[0]!.url).toContain("/ai/run/");
    // Raw bytes as an integer array, NOT a data URI.
    expect(Array.isArray(h.seen[0]!.body["image"])).toBe(true);
    expect(h.seen[0]!.body["image_b64"]).toBeUndefined();
    expect(h.seen[0]!.body["prompt"]).toBe("what color");

    // A text answer comes back as a normal chat completion.
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("a black image");
  });

  it("keeps a text model on the chat shim", async () => {
    const h = await harness(["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
    stubCloudflare(h.seen, () => OPENAI_SHIM("OK"));

    const res = await h.post({
      model: "cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      messages: [{ role: "user", content: "say OK" }],
    });
    expect(res.status).toBe(200);
    expect(h.seen[0]!.url).toContain("chat/completions");
    expect(h.seen[0]!.url).not.toContain("/ai/run/");
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("OK");
  });

  it("refuses an UNVERIFIED model with an explanation, before any request", async () => {
    const h = await harness(["@cf/deepgram/nova-3"]);
    stubCloudflare(h.seen, () => new Response("{}", { headers: { "content-type": "application/json" } }));

    const res = await h.post({
      model: "cloudflare:@cf/deepgram/nova-3",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "QUJD", format: "wav" } }] }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("modality_unsupported");
    expect(body.error.message).toMatch(/no confirmed request shape/i);
    // Refused WITHOUT contacting Workers AI, so it costs nothing.
    expect(h.seen).toHaveLength(0);
  });

  it("maps a shape rejection to a non-retryable invalid-request error", async () => {
    const h = await harness(["@cf/black-forest-labs/flux-1-schnell"]);
    stubCloudflare(h.seen, () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "Bad input: Additional properties", code: 7000 }] }),
        { status: 400, headers: { "content-type": "application/json" } }));

    const res = await h.post({
      model: "cloudflare:@cf/black-forest-labs/flux-1-schnell",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    // A shape error is specific to this model; retrying another candidate
    // would fail identically, so it must not be treated as key-scoped.
    expect(body.error.code).toBe("router_invalid_request");
    expect(body.error.message).toContain("Additional properties");
  });

  it("maps the measured Cloudflare quota code to provider_quota_exhausted", async () => {
    const h = await harness(["@cf/black-forest-labs/flux-1-schnell"]);
    stubCloudflare(h.seen, () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "quota gone", code: 4006 }] }),
        { status: 400, headers: { "content-type": "application/json" } }));

    const res = await h.post({
      model: "cloudflare:@cf/black-forest-labs/flux-1-schnell",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    // The measured Cloudflare code maps onto the EXISTING taxonomy rather than
    // a router-specific one, so the same retry/rotate logic that handles it in
    // the MCP server handles it here.
    expect(body.error.code).toBe("provider_quota_exhausted");
    expect(body.error.message).toContain("quota gone");
  });

  it("requires the virtual key on the modality path too", async () => {
    const h = await harness(["@cf/black-forest-labs/flux-1-schnell"]);
    stubCloudflare(h.seen, () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const res = await fetch(`http://127.0.0.1:${h.handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cloudflare:@cf/black-forest-labs/flux-1-schnell", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(401);
    expect(h.seen).toHaveLength(0);
  });
});
