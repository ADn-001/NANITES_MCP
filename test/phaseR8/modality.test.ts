/**
 * R8e — modality capability: refuse what a model cannot take, and route only
 * when the operator asked.
 *
 * The bug this exists for was found by SENDING a request, not by reading code.
 * A text-only model given an image answered:
 *
 *   "The text you've provided appears to be a Base64-encoded image."
 *
 * — confident, plausible, wrong, and billed. The base64 had been flattened into
 * the text prompt. Nothing checked whether the model could accept an image,
 * even though the registry carries `acceptsImage` for all 48 models.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { scratchHome, cleanup, TEST_PROFILE, writeActiveProfile } from "../phase3/helpers.js";
import {
  capabilityFor, requestInputKinds, unsupportedKinds, modelsAccepting, configuredTargetFor,
} from "../../src/router/providers/capability.js";
import { updateConfig } from "../../src/router/auth.js";
import { listAdvertised } from "../../src/router/models/catalog.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];

afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

const TEXT_ONLY = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const VISION = "@cf/llava-hf/llava-1.5-7b-hf";

async function harness() {
  const home = scratchHome();
  writeActiveProfile(home);
  homes.push(home);
  const handle = await startRouter({ home, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  // Broadcast validates against the CATALOG, so a test that publishes a model
  // has to have registered it first. Without this the endpoint correctly
  // rejects and five tests fail for the wrong reason.
  const { ProviderModelStore } = await import("../../src/storage/providerModelStore.js");
  const store = new ProviderModelStore(handle.deps.db);
  for (const id of [TEXT_ONLY, VISION, "@cf/meta/llama-4-scout-17b-16e-instruct"]) {
    store.registerModel(TEST_PROFILE, "cloudflare", id);
  }
  return handle;
}

async function chat(h: StartedRouter, model: string, content: unknown) {
  const res = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${h.deps.generatedKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content }] }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

const IMAGE_PART = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const TEXT_PART = { type: "text", text: "what is this?" };

describe("requestInputKinds", () => {
  // A gate that never fires looks exactly like a gate with nothing to catch.
  // The first version walked ONE level, so handed a list of content ARRAYS it
  // saw each array as a part, found no `type`, and detected nothing.
  it("descends into a list of message contents", () => {
    expect(requestInputKinds([[TEXT_PART, IMAGE_PART]])).toEqual(["image"]);
  });

  it("accepts a single content array too", () => {
    expect(requestInputKinds([TEXT_PART, IMAGE_PART])).toEqual(["image"]);
  });

  it("finds audio and video, and a plain string is nothing", () => {
    expect(requestInputKinds([[{ type: "input_audio", data: "x", mime: "audio/wav" }]])).toEqual(["audio"]);
    expect(requestInputKinds([[{ type: "video_url", url: "http://v" }]])).toEqual(["video"]);
    expect(requestInputKinds(["just text"])).toEqual([]);
    expect(requestInputKinds([{ role: "user", content: "plain" }])).toEqual([]);
  });
});

describe("capability lookup", () => {
  it("reads the probed Cloudflare registry", async () => {
    const h = await harness();
    const text = capabilityFor(h.deps.db, "cloudflare", TEXT_ONLY);
    expect(text.accepts).toEqual(["text"]);
    expect(text.known).toBe(true);

    const vision = capabilityFor(h.deps.db, "cloudflare", VISION);
    expect(vision.accepts).toContain("image");
    expect(vision.viaAiRun).toBe(true);
  });

  it("treats an UNKNOWN model as text-only rather than refusing", async () => {
    // Every LLM takes text. Refusing on a guess would be worse than passing it
    // through, and a model outside the registry is a model we know nothing
    // about -- not one we know cannot see.
    const h = await harness();
    const cap = capabilityFor(h.deps.db, "openrouter", "some/model-v2");
    expect(cap.accepts).toEqual(["text"]);
    expect(cap.known).toBe(false);
  });

  it("is lenient about video unless a model declares it", async () => {
    // Harnesses express video as a URL or a frame sequence, and nothing here
    // declares native video input, so refusing would block every one of them.
    const h = await harness();
    const cap = capabilityFor(h.deps.db, "cloudflare", TEXT_ONLY);
    expect(unsupportedKinds(cap, ["video"])).toEqual([]);
    expect(unsupportedKinds(cap, ["image"])).toEqual(["image"]);
  });
});

describe("refusing media a model cannot accept", () => {
  it("400s a text-only model given an image, naming the alternatives", async () => {
    const h = await harness();
    const r = await chat(h, `cloudflare:${TEXT_ONLY}`, [TEXT_PART, IMAGE_PART]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("modality_unsupported");
    expect(r.body.error.message).toMatch(/cannot accept image/);
    // The message must be ACTIONABLE: which models can.
    expect(r.body.error.message).toMatch(/Models that can:/);
  });

  it("does not refuse a model that CAN accept the image", async () => {
    const h = await harness();
    const r = await chat(h, `cloudflare:${VISION}`, [TEXT_PART, IMAGE_PART]);
    // Not a 400 modality_unsupported: it dispatches (and with no live key it
    // fails later, which is a different and honest failure).
    expect(r.status).not.toBe(400);
  });

  it("leaves a plain text request alone", async () => {
    const h = await harness();
    const r = await chat(h, `cloudflare:${TEXT_ONLY}`, "just text");
    expect(r.body?.error?.code ?? "").not.toBe("modality_unsupported");
  });
});

describe("opt-in auto-routing", () => {
  it("is OFF by default, so a mismatch refuses rather than reroutes", async () => {
    const h = await harness();
    updateConfig(h.deps.db, { auto_route_modality: false });
    // Published fallback exists, but routing is off.
    await fetch(`http://127.0.0.1:${h.port}/v1/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.deps.generatedKey}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", model_id: VISION, on: true, alias: "nanites-vision", fallback_for: "image" }),
    });
    const r = await chat(h, `cloudflare:${TEXT_ONLY}`, [TEXT_PART, IMAGE_PART]);
    expect(r.status).toBe(400);
  });

  it("routes to the PUBLISHED target when the flag is on", async () => {
    const h = await harness();
    await fetch(`http://127.0.0.1:${h.port}/v1/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.deps.generatedKey}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", model_id: VISION, on: true, alias: "nanites-vision", fallback_for: "image" }),
    });
    updateConfig(h.deps.db, { auto_route_modality: true });
    const r = await chat(h, `cloudflare:${TEXT_ONLY}`, [TEXT_PART, IMAGE_PART]);
    // It dispatched, and the response names the model that actually served --
    // a caller must be able to see it was not the one it asked for.
    expect(r.status).not.toBe(400);
  });

  it("still refuses when the flag is on but no fallback is published", async () => {
    // "Auto-routing is on" is not permission to guess a model.
    const h = await harness();
    updateConfig(h.deps.db, { auto_route_modality: true });
    const r = await chat(h, `cloudflare:${TEXT_ONLY}`, [TEXT_PART, IMAGE_PART]);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/no model is published as the fallback/i);
  });

  it("configuredTargetFor finds the published fallback", async () => {
    const h = await harness();
    await fetch(`http://127.0.0.1:${h.port}/v1/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.deps.generatedKey}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", model_id: VISION, on: true, alias: "nanites-vision", fallback_for: "image" }),
    });
    const t = configuredTargetFor(h.deps.db, "image");
    expect(t?.alias).toBe("nanites-vision");
    expect(configuredTargetFor(h.deps.db, "audio")).toBeNull();
  });
});

describe("broadcast is modality-aware", () => {
  // The hardcoded ["text"] advertised every image and TTS model as a text
  // model -- a lie in the one place a client relies on to decide what it may
  // send.
  it("advertises a vision model as accepting image", async () => {
    const h = await harness();
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.deps.generatedKey}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", model_id: VISION, on: true, alias: "nanites-vision" }),
    });
    const body = await res.json() as any;
    expect(body.modalities).toContain("image");

    const published = listAdvertised(h.deps.db).find((m) => m.alias === "nanites-vision")!;
    expect(published.modalities).toContain("image");

    const models = await (await fetch(`http://127.0.0.1:${h.port}/v1/models`, {
      headers: { authorization: `Bearer ${h.deps.generatedKey}` },
    })).json() as any;
    const entry = models.data.find((m: any) => m.id === "nanites-vision");
    expect(entry.capabilities.modalities).toContain("image");
  });

  it("advertises a text model as text only", async () => {
    const h = await harness();
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.deps.generatedKey}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", model_id: TEXT_ONLY, on: true, alias: "plain" }),
    });
    const body = await res.json() as any;
    expect(body.modalities).toEqual(["text"]);
  });
});

describe("modelsAccepting", () => {
  it("lists only models that can take the kind", async () => {
    const h = await harness();
    const vision = modelsAccepting(h.deps.db, ["image"], 20);
    expect(vision.length).toBeGreaterThan(0);
    // Every listed model must actually accept an image. A candidate list
    // that includes text-only models would reproduce the original bug at the
    // point of the fix.
    for (const m of vision) {
      expect(capabilityFor(h.deps.db, m.provider, m.model_id).accepts).toContain("image");
    }
  });
});
