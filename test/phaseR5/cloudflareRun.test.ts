/**
 * Cloudflare `/ai/run` — the modality path.
 *
 * The OpenAI-compatible shim at `/ai/v1/chat/completions` covers text and
 * vision only. Image generation, TTS, and ASR are reachable only through
 * `/ai/run/{model}`, and each category wants a different body:
 *
 *   image-to-text      { image: number[], prompt }
 *   text-to-image      { prompt, width, ... }
 *   image-to-image     { prompt, image_b64 }
 *   text-to-speech     MeloTTS { prompt, lang } | Aura { text, speaker }
 *   speech-recognition { audio: number[] }
 *
 * The TTS split is the sharpest edge: MeloTTS and Deepgram Aura take DIFFERENT
 * fields for the same job, and sending either shape to the other is a 400.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CF_MODELS, findCfModel, cfInputModalities, cfOutputModalities } from "../../src/router/providers/cloudflare/catalog.js";
import { buildRunBody, decodeRunResponse, fromBase64, runUrl, type CfArtifact } from "../../src/router/providers/cloudflare/run.js";
import { applyCfCapabilities } from "../../src/router/providers/cloudflare/capabilities.js";
import { openNanitesDb } from "../../src/storage/db.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { ROUTER_PROFILE } from "../../src/router/constants.js";
import type { IRRequest } from "../../src/router/ir/types.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const opened: Array<{ close(): void }> = [];

function req(over: Partial<IRRequest> = {}): IRRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: "hello" }],
    max_output_tokens: 100,
    stream: false,
    ...over,
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const pngB64 = PNG.toString("base64");

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  while (homes.length) cleanup(homes.pop()!);
});

describe("registry", () => {
  it("has internally consistent flags on EVERY entry, not just spot-checked ones", () => {
    // This exists because the registry was GENERATED from an external source
    // and the first generation silently wrote `true` for every boolean — a
    // late-binding closure captured the last row's value. A handful of
    // assertions would not have caught that; walking all 50 does.
    for (const m of CF_MODELS) {
      const where = `${m.id} (${m.category})`;
      // A model that emits nothing is not usable and must not be in scope.
      expect(m.returnsText || m.returnsImage || m.returnsAudio, where).toBe(true);
      // A model that accepts nothing cannot be prompted.
      expect(m.acceptsText || m.acceptsImage || m.acceptsAudio, where).toBe(true);
      // Every model here takes TEXT in some form — even the audio-only ASR
      // models are prompted with a text instruction. "acceptsText: false"
      // everywhere is the late-binding generator bug, so assert the shape
      // rather than trusting any single entry.
      const noText = CF_MODELS.filter((x) => !x.acceptsText).map((x) => x.id);
      // ASR and VAD are the only categories that legitimately take no text.
      expect(noText.every((id) => findCfModel(id)!.category === "speech-recognition")).toBe(true);
      // A text-to-image model does NOT accept audio. Nothing in the catalog
      // takes audio AND emits audio.
      for (const x of CF_MODELS) {
        expect(x.acceptsAudio, where).toBe(x.category === "speech-recognition");
      }
      // Category must agree with the return flags, or the request shaping and
      // the capability columns would disagree about what the model does.
      switch (m.category) {
        case "text-to-image":
          expect(m.returnsImage && !m.returnsText, where).toBe(true);
          break;
        case "text-to-speech":
          expect(m.returnsAudio && !m.returnsText, where).toBe(true);
          break;
        case "image-to-image":
          expect(m.returnsImage && m.acceptsImage, where).toBe(true);
          break;
        case "image-to-text":
        case "speech-recognition":
        case "text-generation":
          expect(m.returnsText, where).toBe(true);
          break;
      }
      // No entry may be a duplicate; a collision would make findCfModel
      // return whichever came first.
      expect(CF_MODELS.filter((x) => x.id === m.id), where).toHaveLength(1);
    }
  });

  it("flags a realistic number of deprecated models, not all of them", () => {
    // The exact count is a snapshot, so assert the SHAPE: some deprecated,
    // most not. "Everything is deprecated" is the failure this catches.
    const deprecated = CF_MODELS.filter((m) => m.deprecated).length;
    expect(deprecated).toBeGreaterThan(0);
    expect(deprecated).toBeLessThan(CF_MODELS.length / 2);
  });

  it("covers the six in-scope categories", () => {
    const cats = new Set(CF_MODELS.map((m) => m.category));
    expect([...cats].sort()).toEqual([
      "image-to-image", "image-to-text", "speech-recognition",
      "text-generation", "text-to-image", "text-to-speech",
    ]);
  });

  it("finds models by their full @cf/ id", () => {
    const id = "@cf/black-forest-labs/flux-1-schnell";
    expect(findCfModel(id)?.category).toBe("text-to-image");
    expect(findCfModel("@cf/nope/nope")).toBeUndefined();
  });

  it("derives input and output modalities from the flags", () => {
    const flux = findCfModel("@cf/black-forest-labs/flux-1-schnell")!;
    expect(cfInputModalities(flux)).toEqual(["text"]);
    expect(cfOutputModalities(flux)).toEqual(["image"]);

    const llava = findCfModel("@cf/llava-hf/llava-1.5-7b-hf")!;
    expect(cfInputModalities(llava).sort()).toEqual(["image", "text"]);
    expect(cfOutputModalities(llava)).toEqual(["text"]);

    const nova = findCfModel("@cf/deepgram/nova-3")!;
    expect(cfInputModalities(nova)).toEqual(["audio"]);
    expect(cfOutputModalities(nova)).toEqual(["text"]);
  });

  it("builds the /ai/run URL with the model id as a path segment", () => {
    // The id contains a slash and must NOT be encoded, or the path breaks.
    const url = runUrl("https://api.cloudflare.com/client/v4", "acct123", "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});

describe("request shaping per category", () => {
  it("image-to-text sends RAW BYTES as an integer array, not base64", () => {
    // The one Workers AI shape that is not base64. Sending a data URI here
    // is a 400.
    const model = findCfModel("@cf/llava-hf/llava-1.5-7b-hf")!;
    const body = buildRunBody(model, req({
      messages: [{ role: "user", content: [{ type: "image_url", url: `data:image/png;base64,${pngB64}` }, { type: "text", text: "what is this" }] }],
    }));
    expect(Array.isArray(body["image"])).toBe(true);
    expect((body["image"] as number[]).slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(body["prompt"]).toBe("what is this");
  });

  it("text-to-image sends a prompt and the image options", () => {
    const model = findCfModel("@cf/black-forest-labs/flux-1-schnell")!;
    const body = buildRunBody(model, req({ image_options: { width: 512, height: 512, num_steps: 4 } } as never));
    expect(body["prompt"]).toBe("hello");
    expect(body["width"]).toBe(512);
    expect(body["num_steps"]).toBe(4);
  });

  it("image-to-image sends image_b64, which IS base64 here", () => {
    // Deliberately different from image-to-text: the SAME image is raw bytes
    // for a VQA model and base64 for a diffusion model.
    const model = findCfModel("@cf/runwayml/stable-diffusion-v1-5-img2img")!;
    const body = buildRunBody(model, req({
      messages: [{ role: "user", content: [{ type: "image_url", url: `data:image/png;base64,${pngB64}` }] }],
    }));
    expect(typeof body["image_b64"]).toBe("string");
    expect(body["image"]).toBeUndefined();
  });

  it("MeloTTS takes `prompt` and Deepgram Aura takes `text`", () => {
    // The sharpest edge in this whole file. Same job, incompatible bodies.
    const melo = findCfModel("@cf/myshell-ai/melotts")!;
    const meloBody = buildRunBody(melo, req());
    expect(meloBody["prompt"]).toBe("hello");
    expect(meloBody["text"]).toBeUndefined();
    expect(meloBody["lang"]).toBe("en");

    const aura = findCfModel("@cf/deepgram/aura-1")!;
    const auraBody = buildRunBody(aura, req());
    expect(auraBody["text"]).toBe("hello");
    expect(auraBody["prompt"]).toBeUndefined();
  });

  it("speech-recognition sends audio as a raw byte array", () => {
    const model = findCfModel("@cf/deepgram/nova-3")!;
    const body = buildRunBody(model, req(), "QUJD");
    expect((body["audio"] as number[])).toEqual([65, 66, 67]);
  });

  it("text-generation sends the OpenAI-shaped messages", () => {
    const model = findCfModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")!;
    const body = buildRunBody(model, req());
    expect(Array.isArray(body["messages"])).toBe(true);
    expect(body["max_tokens"]).toBe(100);
  });
});

describe("response decoding", () => {
  function res(contentType: string, body: string | Uint8Array): Response {
    return new Response(body as BodyInit, { headers: { "content-type": contentType } });
  }

  it("decodes a { result } text envelope", async () => {
    const out = await decodeRunResponse(res("application/json", JSON.stringify({ result: "the answer" })), findCfModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")!, 5);
    expect(out.text).toBe("the answer");
    expect(out.artifact).toBeNull();
  });

  it("decodes a BINARY image, not a JSON envelope", async () => {
    const out = await decodeRunResponse(res("image/png", PNG), findCfModel("@cf/black-forest-labs/flux-1-schnell")!, 5);
    expect(out.text).toBeNull();
    const art = out.artifact as CfArtifact;
    expect(art.kind).toBe("image");
    expect(art.bytes).toBe(PNG.length);
    expect(Buffer.from(art.b64, "base64").equals(PNG)).toBe(true);
  });

  it("decodes BINARY audio from a TTS model", async () => {
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    const out = await decodeRunResponse(res("audio/mpeg", mp3), findCfModel("@cf/deepgram/aura-1")!, 5);
    expect(out.artifact?.kind).toBe("audio");
    expect(out.artifact?.mime).toBe("audio/mpeg");
  });

  it("decodes application/octet-stream as a PNG", async () => {
    const out = await decodeRunResponse(res("application/octet-stream", PNG), findCfModel("@cf/stabilityai/stable-diffusion-xl-base-1.0")!, 5);
    expect(out.artifact?.kind).toBe("image");
    expect(out.artifact?.mime).toBe("image/png");
  });

  it("raises a structured error for a Workers AI error envelope", async () => {
    const body = JSON.stringify({ success: false, errors: [{ message: "model not allowed" }] });
    await expect(decodeRunResponse(res("application/json", body), findCfModel("@cf/meta/phi-2")!, 5))
      .rejects.toMatchObject({ message: "model not allowed" });
  });

  it("falls back to raw text for a non-JSON body", async () => {
    const out = await decodeRunResponse(res("text/plain", "just words"), findCfModel("@cf/deepgram/nova-3")!, 5);
    expect(out.text).toBe("just words");
  });

  it("round-trips base64 through fromBase64", () => {
    expect(Buffer.from(fromBase64(pngB64)).equals(PNG)).toBe(true);
    // A data: URI prefix is stripped, since callers may send either form.
    expect(Buffer.from(fromBase64(`data:image/png;base64,${pngB64}`)).equals(PNG)).toBe(true);
  });
});

describe("capability population", () => {
  it("fills modalities ONLY for models discovery actually found", () => {
    const home = scratchHome();
    homes.push(home);
    const { db, close } = openNanitesDb(home);
    opened.push({ close });

    const store = new ProviderModelStore(db);
    // Discovery "found" exactly these two.
    store.registerModel(ROUTER_PROFILE, "cloudflare", "@cf/black-forest-labs/flux-1-schnell");
    store.registerModel(ROUTER_PROFILE, "cloudflare", "@cf/deepgram/nova-3");

    const written = applyCfCapabilities(db);
    expect(written).toBe(2);

    const flux = store.getModel(ROUTER_PROFILE, "cloudflare", "@cf/black-forest-labs/flux-1-schnell")!;
    // An image model that emits nothing the router understands would be
    // invisible to the planner, so its output modality must be recorded.
    expect(flux.supported_modalities).toEqual(["image"]);

    const nova = store.getModel(ROUTER_PROFILE, "cloudflare", "@cf/deepgram/nova-3")!;
    expect(nova.supported_modalities).toEqual(["text"]);
    // Audio INPUT capability: nothing else populates this column.
    expect(nova.capabilities.audio).toBe(true);

    // A registry model that discovery did NOT find gets no row at all.
    expect(store.getModel(ROUTER_PROFILE, "cloudflare", "@cf/moonshot/kimi-k2.6")).toBeNull();
  });

  it("marks a text-generation model as function-calling capable", () => {
    const home = scratchHome();
    homes.push(home);
    const { db, close } = openNanitesDb(home);
    opened.push({ close });
    const store = new ProviderModelStore(db);
    store.registerModel(ROUTER_PROFILE, "cloudflare", "@cf/meta/llama-4-scout-17b-16e-instruct");
    applyCfCapabilities(db);
    const m = store.getModel(ROUTER_PROFILE, "cloudflare", "@cf/meta/llama-4-scout-17b-16e-instruct")!;
    expect(m.capabilities.function_calling).toBe(true);
    // Llama 4 Scout is natively multimodal, so it both accepts images and emits text.
    expect(m.capabilities.vision).toBe(true);
    expect(m.supported_modalities).toEqual(["text"]);
  });
});
