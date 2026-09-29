/**
 * The Cloudflare `/ai/run/{model}` path.
 *
 * This is the reason the registry exists. The OpenAI-compatible
 * `/ai/v1/chat/completions` shim covers text and vision only, so image
 * generation, TTS, and speech recognition are unreachable without this.
 *
 * Response handling is the part that is easy to get wrong. Workers AI returns,
 * depending on the model:
 *   - `{ result: ... }` JSON for text output
 *   - RAW BINARY (PNG / MP3) for image and audio, signalled by Content-Type
 *   - SSE text when `stream: true`
 *
 * So this cannot go through `parseChatResponse`, and the caller has to be told
 * which of the three it got.
 */
import { NanitesError } from "../../../helpers/errors.js";
import { findCfModel, type CfModelDef } from "./catalog.js";
import type { IRRequest } from "../../ir/types.js";
import { partsToText } from "../../ir/types.js";

export interface CfArtifact {
  kind: "image" | "audio";
  /** Base64, without a data-URI prefix. */
  b64: string;
  mime: string;
  bytes: number;
}

export interface CfRunResult {
  /** Text answer, when the model returns text. */
  text: string | null;
  /** Binary artifact, when it returns image or audio. */
  artifact: CfArtifact | null;
  finish_reason: string;
  latency_ms: number;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Base64 (or a data: URI) to bytes. */
export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/^data:[^;]+;base64,/, "");
  return new Uint8Array(Buffer.from(clean, "base64"));
}

/**
 * Build the `/ai/run` request body for a model, from the IR.
 *
 * The category decides the shape, and two cases are genuinely special:
 *  - LLaVA and Moondream take `prompt`, not `messages`.
 *  - MeloTTS takes `prompt`+`lang`; Deepgram Aura takes `text`+`speaker`.
 */
export function buildRunBody(model: CfModelDef, request: IRRequest, audioB64?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const text = partsToText(request.messages[request.messages.length - 1]?.content ?? "");

  switch (model.category) {
    case "image-to-text": {
      // { image: number[], prompt } — the image is RAW BYTES as an integer
      // array, which is the one Workers AI shape that is not base64.
      const image = findImagePart(request);
      if (image) body["image"] = Array.from(fromBase64(image.url));
      body["prompt"] = text || "Describe this image";
      return body;
    }

    case "text-to-image": {
      body["prompt"] = text;
      // Only the parameters THIS model accepts. Probed: flux-1-schnell takes
      // `prompt` alone and 400s on any other documented parameter, so
      // forwarding whatever the caller supplied would fail the request rather
      // than tune it.
      const allowed = new Set(model.params ?? []);
      const opts = (request as { image_options?: Record<string, unknown> }).image_options ?? {};
      for (const [k, v] of Object.entries(opts)) {
        if (allowed.has(k)) body[k] = v;
      }
      return body;
    }

    case "image-to-image": {
      body["prompt"] = text;
      const image = findImagePart(request);
      if (image) body["image_b64"] = image.url;
      return body;
    }

    case "text-to-speech": {
      if (model.id === "@cf/myshell-ai/melotts") {
        body["prompt"] = text;
        body["lang"] = (request as { lang?: string }).lang ?? "en";
      } else {
        // Deepgram Aura: `text`, not `prompt`.
        body["text"] = text;
      }
      const voice = (request as { speaker?: string }).speaker;
      if (voice) body["speaker"] = voice;
      return body;
    }

    case "speech-recognition": {
      if (audioB64) body["audio"] = Array.from(fromBase64(audioB64));
      return body;
    }

    default: {
      // text-generation: the standard OpenAI-shaped body.
      body["messages"] = request.messages.map((m) => ({ role: m.role, content: m.content }));
      const image = findImagePart(request);
      if (image) body["image"] = Array.from(fromBase64(image.url));
      if (request.max_output_tokens) body["max_tokens"] = request.max_output_tokens;
      if (request.temperature !== undefined) body["temperature"] = request.temperature;
      if (request.stop) body["stop"] = request.stop;
      return body;
    }
  }
}

function findImagePart(request: IRRequest): { url: string } | null {
  for (const m of request.messages) {
    if (typeof m.content === "string") continue;
    const img = m.content.find((p) => p.type === "image_url");
    if (img && img.type === "image_url") return { url: img.url };
  }
  return null;
}

/**
 * Decode a Workers AI response into text or an artifact.
 *
 * The Content-Type is the signal, and it is the ONLY reliable one: a TTS
 * response has no JSON envelope at all.
 */
export async function decodeRunResponse(res: Response, model: CfModelDef, latencyMs: number): Promise<CfRunResult> {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.startsWith("image/") || contentType === "application/octet-stream") {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      text: null,
      artifact: { kind: "image", b64: toBase64(bytes), mime: contentType === "application/octet-stream" ? "image/png" : contentType, bytes: bytes.byteLength },
      finish_reason: "stop",
      latency_ms: latencyMs,
    };
  }

  if (contentType.startsWith("audio/")) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      text: null,
      artifact: { kind: "audio", b64: toBase64(bytes), mime: contentType, bytes: bytes.byteLength },
      finish_reason: "stop",
      latency_ms: latencyMs,
    };
  }

  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Workers AI wraps the payload in `result`; a top-level error shape comes
    // back as { success: false, errors: [...] }.
    if (parsed["success"] === false) {
      const errs = parsed["errors"] as Array<{ message?: string }> | undefined;
      throw new NanitesError({
        code: "provider_server_error",
        message: errs?.[0]?.message ?? "Workers AI returned an error envelope.",
        retryable: false,
      });
    }
    const result = parsed["result"];

    if (result && typeof result === "object" && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;

      // FLUX returns { result: { image: "<base64 png>" } } as JSON, NOT as an
      // image/png body. Probed: Content-Type is application/json here, so the
      // binary branch above never sees it, and a naive decode would hand the
      // caller a JSON blob where an image belongs.
      const image = obj["image"];
      if (typeof image === "string" && image.length > 0) {
        return {
          text: null,
          artifact: { kind: "image", b64: image, mime: "image/png", bytes: fromBase64(image).byteLength },
          finish_reason: "stop",
          latency_ms: latencyMs,
        };
      }

      // MeloTTS returns base64 WAV INSIDE the JSON envelope, not as an
      // audio/wav body — the opposite of Deepgram Aura, which returns real
      // audio bytes and never reaches this branch. Probed.
      const audio = obj["audio"];
      if (typeof audio === "string" && audio.length > 0) {
        return {
          text: null,
          artifact: { kind: "audio", b64: audio, mime: "audio/wav", bytes: fromBase64(audio).byteLength },
          finish_reason: "stop",
          latency_ms: latencyMs,
        };
      }

      // text-generation nests a FULL OpenAI chat-completion object inside
      // `result`, with the answer at result.response. Returning
      // JSON.stringify(result) would put an entire completion envelope in the
      // model's text field, which is worse than useless to a caller. Probed.
      const response = obj["response"];
      if (typeof response === "string") {
        return { text: response, artifact: null, finish_reason: "stop", latency_ms: latencyMs };
      }
      // A VQA model returns { description: "..." } instead.
      const description = obj["description"];
      if (typeof description === "string") {
        return { text: description, artifact: null, finish_reason: "stop", latency_ms: latencyMs };
      }
    }

    if (typeof result === "string") {
      return { text: result, artifact: null, finish_reason: "stop", latency_ms: latencyMs };
    }
    return { text: JSON.stringify(result), artifact: null, finish_reason: "stop", latency_ms: latencyMs };
  } catch (err) {
    if (err instanceof NanitesError) throw err;
    // Not JSON at all — an SSE body, or a plain-text answer.
    return { text, artifact: null, finish_reason: "stop", latency_ms: latencyMs };
  }
}

/** The `/ai/run` URL for a model. */
export function runUrl(base: string, accountId: string, modelId: string): string {
  // The model id contains a slash (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
  // and is a PATH SEGMENT, so it is not encoded.
  return `${base}/accounts/${accountId}/ai/run/${modelId}`;
}

export { findCfModel };
