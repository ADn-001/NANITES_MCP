/**
 * Phase 45 gate — vision wire.
 * Covers:
 * 1. Content-parts typing: user messages with images serialize to OpenAI wire
 *    `image_url` parts (data URI + http URL) via serializeChatRequest; plain
 *    string messages and tool-loop history pass through unchanged (no image
 *    inside tool rounds).
 * 2. Image input resolution: local path -> bounded base64 data URI; http(s) and
 *    data: pass through; exact refusals (unsupported scheme, missing file,
 *    oversized file) as structured errors.
 * 3. Vision model resolution: auto-pick of the best registered vision-capable
 *    model, `vision` pin honored, pin fallback, and exact rejection codes
 *    (local provider, explicit cloud model without provider, nothing usable).
 * 4. run_sub_agent: images rejected on a local run and on an fs tool-loop run;
 *    a cloud vision run carries the image_url data URI to the provider (via
 *    stubbed fetch) and routes to the registered vision model.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, openSync, closeSync, truncateSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { RolePinStore } from "../../src/storage/rolePinStore.js";
import { resolveRoleModel, type ResolvedRoleModel } from "../../src/workflows/resolveRoleModel.js";
import { runSubAgent } from "../../src/workflows/runSubAgent.js";
import { serializeChatRequest } from "../../src/providers/client.js";
import {
  buildVisionContent,
  resolveImageUri,
  resolveImageUris,
} from "../../src/providers/vision.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const PNGBYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GEM = "@cf/google/gemma-4-26b-a4b-it";
const VLM = "@cf/meta/llama-3.2-11b-vision-instruct";
const homes: ToolDeps[] = [];
const dirs: string[] = [];

function tmp(name: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `nanites-ph45-${name}-`));
  dirs.push(d);
  // Vision reads are confined to an allowlisted root. Every image
  // in this suite lives in a tmp dir, so the simplest correct root is the one
  // tmp() just made.
  process.env.NANITES_VISION_ROOTS = d;
  return d;
}

function harness(profileName: string, opts?: { toolsEnabled?: boolean; root?: string }): { d: ToolDeps; profileName: string } {
  const d = buildDeps(scratchHome());
  homes.push(d);
  d.profiles.createProfile({
    name: profileName,
    ...(opts?.toolsEnabled
      ? { tools: { enabled: true, integrations: [], fs: { root: opts.root ?? process.cwd() } } }
      : {}),
  });
  d.profiles.switchProfile(profileName);
  return { d, profileName };
}

function addKey(d: ToolDeps, profile: string, provider: string): void {
  new ProviderKeyStore(d.db).addKey(profile, provider as never, `sk-test-${profile}-${Math.random().toString(36).slice(2)}`);
}

function addVisionModel(d: ToolDeps, profile: string, provider: string, modelId: string, perf?: number): void {
  new ProviderModelStore(d.db).registerManifestModel(profile, provider as never, {
    model_id: modelId,
    context_length: null,
    vision: true,
    function_calling: true,
  });
  if (perf !== undefined) {
    const existing = d.registry.get(profile, modelId);
    d.registry.upsert(profile, {
      model_id: modelId,
      provider,
      roles: existing?.roles ?? ["vision"],
      scores: existing?.scores ?? {},
      last_tested: existing?.last_tested ?? null,
      performance_score: perf,
    });
  }
}

async function expectCode(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  let threw: unknown;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeTruthy();
  expect((threw as { code?: string }).code).toBe(code);
}

function resolve(d: ToolDeps, profileName: string, input?: Parameters<typeof resolveRoleModel>[2]): ResolvedRoleModel {
  const profile = d.profiles.getProfile(profileName)!;
  return resolveRoleModel(d, profile, input ?? {});
}

afterAll(() => {
  for (const d of homes.splice(0)) {
    d.close();
    cleanup(d.home);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Phase 45 — content-part wire", () => {
  it("serializeChatRequest carries user image parts and keeps text history as strings", () => {
    const out = serializeChatRequest({
      model: GEM,
      messages: [
        { role: "system", content: "be terse" },
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
            { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
          ],
        },
        { role: "assistant", content: "one circle", tool_calls: [{ id: "c1", name: "read_file", arguments: {} }] },
        { role: "tool", content: "ok", tool_call_id: "c1" },
      ],
    });
    const msgs = out.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]!.content).toBe("be terse");
    // The multimodal user turn serializes as parts, image_url intact.
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "what is in this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
      { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
    ]);
    // Tool-round history stays string content — no image parts are injected.
    expect(msgs[2]!.content).toBe("one circle");
    expect(msgs[3]!.content).toBe("ok");
  });

  it("buildVisionContent leads with text and appends the image parts", () => {
    const parts = buildVisionContent("spot the dog", ["data:image/jpeg;base64,BBB="]);
    expect(parts[0]).toEqual({ type: "text", text: "spot the dog" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB=" } });
    const fallback = buildVisionContent("   ", ["data:image/png;base64,CCC="]);
    expect((fallback[0] as { type: "text"; text: string }).text.length).toBeGreaterThan(0);
  });
});

describe("Phase 45 — image input resolution", () => {
  it("local path -> base64 data URI from magic bytes; URL and data: pass through", async () => {
    const dir = tmp("reader");
    const file = path.join(dir, "shot.png");
    writeFileSync(file, PNGBYTES);
    const [uri, url, data] = await resolveImageUris([file, "https://cdn.example.com/a.png", "data:image/png;base64,QUJDPQ=="]);
    expect(uri).toBe(`data:image/png;base64,${PNGBYTES.toString("base64")}`);
    expect(url).toBe("https://cdn.example.com/a.png");
    expect(data).toBe("data:image/png;base64,QUJDPQ==");
  });

  it("unknown scheme is refused", async () => {
    await expectCode(() => resolveImageUri("ftp://host/x.png"), "unsupported_image_source");
  });

  it("missing file is refused", async () => {
    // tmp() registers the dir as an allowed vision root, so the path is
    // in-root and fails at open time rather than at the confinement check.
    await expectCode(() => resolveImageUri(path.join(tmp("gone"), "nope.png")), "image_not_found");
  });

  it("oversized file is refused before read", async () => {
    const dir = tmp("big");
    const file = path.join(dir, "huge.png");
    const fd = openSync(file, "w");
    closeSync(fd);
    truncateSync(file, 21 * 1024 * 1024);
    // The read is confined, so the file has to sit inside an allowed root to
    // reach the size check at all.
    process.env.NANITES_VISION_ROOTS = dir;
    await expectCode(() => resolveImageUri(file), "image_too_large");
    delete process.env.NANITES_VISION_ROOTS;
  });
});

describe("Phase 45 — vision model resolution", () => {
  it("no pin: auto-picks the best registered vision model on the first usable provider", () => {
    const { d, profileName } = harness("v-auto");
    addKey(d, profileName, "cloudflare");
    addVisionModel(d, profileName, "cloudflare", GEM, 70);
    addVisionModel(d, profileName, "cloudflare", VLM, 90);
    const r = resolve(d, profileName, { vision: true });
    expect(r.provider).toBe("cloudflare");
    expect(r.model_id).toBe(VLM); // higher performance_score wins
    expect(r.source).toBe("dynamic_cloud");
  });

  it("vision pin is honored", () => {
    const { d, profileName } = harness("v-pin");
    addKey(d, profileName, "cloudflare");
    addVisionModel(d, profileName, "cloudflare", VLM);
    new RolePinStore(d.db).set(profileName, { role: "vision", provider: "cloudflare", model_id: VLM });
    const r = resolve(d, profileName, { vision: true });
    expect(r).toMatchObject({ provider: "cloudflare", model_id: VLM, source: "pin" });
  });

  it("unusable vision pin falls back to another registered vision model on the same provider", () => {
    const { d, profileName } = harness("v-pin-fb");
    addKey(d, profileName, "cloudflare");
    addVisionModel(d, profileName, "cloudflare", GEM);
    new RolePinStore(d.db).set(profileName, { role: "vision", provider: "cloudflare", model_id: "@cf/ghost-vision" });
    const r = resolve(d, profileName, { vision: true });
    expect(r.provider).toBe("cloudflare");
    expect(r.model_id).toBe(GEM);
    expect(r.source).toBe("pin_fallback_dynamic");
  });

  it("vision never routes local: explicit local provider is refused", async () => {
    const { d, profileName } = harness("v-local");
    addVisionModel(d, profileName, "cloudflare", GEM);
    await expectCode(() => resolve(d, profileName, { vision: true, explicitProvider: "local" }), "vision_local_not_supported");
  });

  it("explicit vision model with no cloud provider is refused (image runs never default local)", async () => {
    const { d, profileName } = harness("v-explicit-noprov");
    await expectCode(() => resolve(d, profileName, { vision: true, explicitModel: GEM }), "vision_requires_cloud_provider");
  });

  it("explicit cloud vision model is honored", () => {
    const { d, profileName } = harness("v-explicit");
    const r = resolve(d, profileName, { vision: true, explicitProvider: "cloudflare", explicitModel: GEM });
    expect(r).toMatchObject({ provider: "cloudflare", model_id: GEM, source: "explicit" });
  });

  it("nothing usable anywhere is a structured no_vision_model_registered", async () => {
    const { d, profileName } = harness("v-none");
    await expectCode(() => resolve(d, profileName, { vision: true }), "no_vision_model_registered");
  });
});

describe("Phase 45 — run_sub_agent vision gates + wire", () => {
  it("images on an explicit local run are rejected", async () => {
    const { d, profileName } = harness("rs-local");
    await expectCode(
      () => runSubAgent(d, profileName, "describe", { provider: "local", images: ["data:image/png;base64,QUJD"] }),
      "vision_local_not_supported",
    );
  });

  it("images combined with the fs tool loop are rejected", async () => {
    const dir = tmp("fs");
    writeFileSync(path.join(dir, "shot.png"), PNGBYTES);
    const { d, profileName } = harness("rs-fs", { toolsEnabled: true, root: dir });
    addKey(d, profileName, "cloudflare");
    addVisionModel(d, profileName, "cloudflare", GEM);
    await expectCode(
      () => runSubAgent(d, profileName, "describe", { images: [path.join(dir, "shot.png")] }),
      "vision_with_tool_loop",
    );
  });

  it("a cloud vision run sends the image_url data URI to the provider and routes to the vision model", async () => {
    const dir = tmp("e2e");
    const file = path.join(dir, "shot.png");
    writeFileSync(file, PNGBYTES);
    const { d, profileName } = harness("rs-e2e");
    addKey(d, profileName, "generic");
    addVisionModel(d, profileName, "generic", "meta-llama/llama-3.2-11b-vision-instruct", 88);

    let sentBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          id: "resp-1",
          choices: [{ message: { role: "assistant", content: "A red circle on white." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const res = await runSubAgent(d, profileName, "what is in this image?", {
        images: [file],
      });
      expect(res.model_id).toBe("meta-llama/llama-3.2-11b-vision-instruct");
      expect(res.instance_id).toMatch(/^cloud:/);
      expect(res.reply).toContain("red circle");

      const wire = JSON.parse(sentBody) as { model?: string; messages: Array<{ role: string; content: unknown }> };
      expect(wire.model).toBe("meta-llama/llama-3.2-11b-vision-instruct");
      const userMsg = wire.messages.find((m) => m.role === "user");
      const parts = userMsg!.content as Array<{ type: string; image_url?: { url: string } }>;
      const imagePart = parts.find((p) => p.type === "image_url");
      expect(imagePart?.image_url?.url).toBe(`data:image/png;base64,${PNGBYTES.toString("base64")}`);
      // The run is tool-less: no tools advertised on the wire.
      expect((wire as { tools?: unknown }).tools).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
