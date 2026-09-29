/**
 * R8 — optional helper models.
 *
 * The single most important property in this file is NEGATIVE: the router is
 * complete and correct with neither helper installed. Every test in the first
 * block runs with helpers explicitly unavailable, and the assertions are the
 * behaviours that existed before helpers did.
 *
 * The interface shapes were established by probing the real packages, not
 * their documentation — Laya rejects `options` and a bare label dict, and
 * requires `instructions` plus `criteria`, and getting any of those wrong
 * produces a ValueError that does not name the field.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { LayaHelper } from "../../src/router/helpers/laya.js";
import { UnavailableHelper } from "../../src/router/helpers/interface.js";
import { helperStatus, guessModality, HELPER_ALIASES, resolveHelperAlias } from "../../src/router/helpers/registry.js";
import { resolveTarget } from "../../src/router/outbound/resolve.js";
import { decodeOpenAiRequest } from "../../src/router/inbound/openai.js";
import { decodeAnthropicRequest } from "../../src/router/inbound/anthropic.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { scratchHome, cleanup, TEST_PROFILE, writeActiveProfile } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];

async function harness(enableHelpers = false) {
  const h = scratchHome();
  // The router resolves the ACTIVE profile, so a store call inside this test
  // needs one to exist. Omitting it produced "cannot be bound to SQLite
  // parameter 1" from an unrelated-looking failure.
  writeActiveProfile(h);
  homes.push(h);
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  handle.deps.db
    .prepare("UPDATE router_config SET enable_helpers = ? WHERE id = 1")
    .run(enableHelpers ? 1 : 0);
  return handle;
}

afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

describe("the router is complete WITHOUT helpers", () => {
  it("reports both helpers unavailable when they are disabled", async () => {
    const h = await harness(false);
    const status = helperStatus(h.deps.db);
    expect(status.needle.available).toBe(false);
    expect(status.laya.available).toBe(false);
    // The reason is reported, so "disabled" is distinguishable from "broken".
    expect(status.needle.reason).toMatch(/disabled/i);
  });

  it("classifies modality from CONTENT, with no helper involved", async () => {
    const h = await harness(false);
    expect((await guessModality(h.deps.db, [{ type: "input_audio", data: "x", mime: "audio/wav" }])).modality)
      .toBe("audio");
    expect((await guessModality(h.deps.db, [{ type: "image_url", url: "http://x/y.png" }])).modality)
      .toBe("image");
    expect((await guessModality(h.deps.db, [{ type: "video_url", url: "http://x/y.mp4" }])).modality)
      .toBe("video");
  });

  it("honours a DECLARED modality over any inference", async () => {
    const h = await harness(false);
    const guess = await guessModality(h.deps.db, [{ type: "image_url", url: "http://x" }], "text");
    // An explicit declaration is the caller's decision; content parts are a
    // hint, not an override.
    expect(guess.modality).toBe("text");
    expect(guess.source).toBe("declared");
  });

  it("falls back to text for an unremarkable request", async () => {
    const h = await harness(false);
    const guess = await guessModality(h.deps.db, [{ type: "text", text: "hello" }]);
    expect(guess.modality).toBe("text");
    expect(guess.source).toBe("default");
  });

  it("still starts, serves health, and reports helpers false", async () => {
    const h = await harness(false);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/health`, {
      headers: { authorization: `Bearer ${h.deps.generatedKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { helpers: { needle: boolean; laya: boolean } };
    expect(body.helpers.needle).toBe(false);
    expect(body.helpers.laya).toBe(false);
  });

  it("does NOT advertise a helper that is unavailable", async () => {
    const h = await harness(false);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/models`, {
      headers: { authorization: `Bearer ${h.deps.generatedKey}` },
    });
    const text = await res.text();
    // A listed-but-missing model is a request-time failure, which is exactly
    // what the advertised catalog exists to prevent.
    expect(text).not.toContain("nanites-needle-embed");
    expect(text).not.toContain("nanites-laya-classify");
  });

  it("returns a null answer from an unavailable helper, never a throw", async () => {
    const helper = new UnavailableHelper("x", "not installed");
    expect(helper.available()).toBe(false);
    expect((await helper.classify()).choice).toBeNull();
    expect((await helper.score()).score).toBeNull();
    expect((await helper.retrieve()).indices).toEqual([]);
    expect(await helper.extract()).toBeNull();
  });
});

/**
 * Resolution. The invariant is that a helper id can NEVER be answered by a
 * paid provider — the first version of this code did exactly that.
 */
describe("a helper id never routes to a paid provider", () => {
  it("resolves a helper alias to the helper provider, with ONE cloud key present", async () => {
    // THE regression. `parseModelId` does not know "helper" is a provider
    // head, so before the check was added this fell through to the bare-id
    // search — and with exactly one provider keyed that search SUCCEEDS:
    //   helper:needle3:extract -> {provider:"cloudflare", ...}
    // A free local request silently billed to a cloud account, no error raised.
    const h = await harness(false);
    new ProviderKeyStore(h.deps.db).addKey(TEST_PROFILE, "cloudflare", "sk-x", { accountId: "acct1" });

    for (const entry of HELPER_ALIASES) {
      for (const id of [entry.alias, entry.real_id]) {
        const target = resolveTarget(h.deps.db, id);
        expect(target.provider).toBe("helper");
        expect(target.stored_id).toBe(entry.real_id);
      }
    }
  });

  it("resolves a helper alias with NO provider configured at all", async () => {
    // The other half: with zero keys the bare-id path used to fail with
    // `provider_key_required`, pointing an operator at the key store when the
    // real answer was "that is a local model and it is fine".
    const h = await harness(false);
    expect(resolveTarget(h.deps.db, "nanites-needle-extract").provider).toBe("helper");
  });

  it("every advertised alias is dispatchable, and every real_id is unique", () => {
    // "Advertised means callable" holds by construction: one constant, and
    // both the catalog and the resolver read it.
    const aliases = HELPER_ALIASES.map((h) => h.alias);
    const realIds = HELPER_ALIASES.map((h) => h.real_id);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(new Set(realIds).size).toBe(realIds.length);
    for (const entry of HELPER_ALIASES) {
      expect(resolveHelperAlias(entry.alias)).toEqual(entry);
      expect(resolveHelperAlias(entry.real_id)).toEqual(entry);
    }
    expect(resolveHelperAlias("nope")).toBeNull();
  });

  it("does not shadow a real advertised model", async () => {
    // The check is first because it must be, but it must also be NARROW: a
    // name an operator published still resolves to their model, not a helper.
    const h = await harness(false);
    h.deps.db.prepare(
      "INSERT INTO router_advertised (alias, real_id, provider, modalities, context_window, created_at) VALUES (?,?,?,?,?,?)",
    ).run("flash", "some-model", "openrouter", JSON.stringify(["text"]), null, new Date().toISOString());
    expect(resolveTarget(h.deps.db, "flash").provider).toBe("openrouter");
  });
});

describe("interface shapes established by probing", () => {
  it("builds a choice question Laya actually accepts", () => {
    // `criteria`, not `options`; `instructions` is required. The real package
    // rejects the looser shapes its documentation implies.
    const q = LayaHelper.choiceQuestion("kind", "Pick a label.", ["a", "b"]);
    const inner = (q["kind"]) as Record<string, unknown>;
    expect(inner["type"]).toBe("choice");
    expect(inner["instructions"]).toBe("Pick a label.");
    expect(inner["criteria"]).toEqual({ a: "a", b: "b" });
    // `options` is what a reasonable person would write, and it is wrong.
    expect(inner).not.toHaveProperty("options");
  });

  it("declines a choice question with fewer than two options", async () => {
    // One option is not a decision; answering it would be theatre.
    const helper = new LayaHelper();
    expect((await helper.classify("state", ["only"])).choice).toBeNull();
  });

  it("Laya cannot extract, and says so rather than returning nothing useful", async () => {
    // Laya emits no text at all, so there is no structured-output path.
    expect(await new LayaHelper().extract()).toBeNull();
    // And it cannot embed, so retrieval is Needle's job — not an empty list
    // dressed as an answer.
    expect((await new LayaHelper().retrieve("q", ["a", "b"])).indices).toEqual([]);
  });
});

/**
 * The HTTP surface. These run against a real server on a scratch home, and the
 * helper Python packages are NOT assumed present — so the assertions are about
 * the router's behaviour around them: what it refuses, what it says, and what
 * it never claims.
 */
describe("the helper HTTP surface", () => {
  const call = async (
    h: StartedRouter,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${h.deps.generatedKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  it("reports the disabled state and refuses a helper route with a reason", async () => {
    const h = await harness(false);

    const cfg = await call(h, "GET", "/v1/config");
    expect(cfg.status).toBe(200);
    expect(cfg.body.enable_helpers).toBe(false);
    // The distinction that matters: "off" is not the same as "on but broken".
    expect(cfg.body.helpers.needle.reason).toMatch(/disabled/i);

    const out = await call(h, "POST", "/v1/helpers/extract", { text: "x", schema: { a: "str" } });
    expect(out.status).toBe(503);
    expect(out.body.error.code).toBe("helper_unavailable");
    expect(out.body.error.message).toMatch(/enable_helpers/);
  });

  it("rejects a non-boolean and an unwritable field instead of ignoring them", async () => {
    // A silently-dropped field reads as "the router took my setting" and is
    // discovered days later with the flag still off.
    const h = await harness(false);
    expect((await call(h, "PATCH", "/v1/config", { enable_helpers: "yes" })).status).toBe(400);
    const port = await call(h, "PATCH", "/v1/config", { port: 9999 });
    expect(port.status).toBe(400);
    expect(port.body.error.message).toMatch(/not a writable config field/);
  });

  it("a writable flag round-trips through the config route", async () => {
    const h = await harness(false);
    const patched = await call(h, "PATCH", "/v1/config", { enable_helpers: true });
    expect(patched.status).toBe(200);
    expect(patched.body.enable_helpers).toBe(true);
    expect((await call(h, "GET", "/v1/config")).body.enable_helpers).toBe(true);
    // And back off again.
    expect((await call(h, "PATCH", "/v1/config", { enable_helpers: false })).body.enable_helpers).toBe(false);
  });

  it("rejects a bad request body before probing anything", async () => {
    const h = await harness(false);
    // Fewer than two options is not a decision, and asking anyway would spend
    // a 90-second model load to return a null.
    const one = await call(h, "POST", "/v1/helpers/classify", { state: "s", options: ["only"] });
    expect(one.status).toBe(400);
    expect(one.body.error.code).toBe("router_invalid_request");
  });

  it("refuses stream:true for a helper instead of 402 or a fabricated stream", async () => {
    // Pre-header, so the caller gets a real JSON error. Before the helper
    // branch existed this reached the key machinery and returned a
    // misleading "every key on provider helper failed" (402).
    const h = await harness(true);
    const out = await call(h, "POST", "/v1/chat/completions", {
      model: "nanites-laya-classify",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.status).toBe(400);
    expect(out.body.error.message).toMatch(/does not support stream/);
  });

  it("advertises nothing when helpers are off, and only callable things when on", async () => {
    const off = await harness(false);
    const offModels = await call(off, "GET", "/v1/models");
    for (const entry of HELPER_ALIASES) {
      expect(JSON.stringify(offModels.body)).not.toContain(entry.alias);
    }

    // With the flag on the aliases appear — and each one RESOLVES, which is
    // the invariant the old hand-written catalog entries broke. The Python
    // packages may or may not be installed here, so assert the DIRECTION
    // rather than a count: anything advertised must resolve.
    const on = await harness(true);
    const onModels = await call(on, "GET", "/v1/models");
    const advertised = HELPER_ALIASES.map((e) => e.alias)
      .filter((a) => JSON.stringify(onModels.body).includes(a));
    for (const alias of advertised) {
      expect(resolveTarget(on.deps.db, alias).provider).toBe("helper");
    }
  });

  it("a helper job is refused, because a job is a provider generation", async () => {
    const h = await harness(true);
    const out = await call(h, "POST", "/v1/jobs", {
      model: "nanites-needle-extract",
      body: { model: "nanites-needle-extract", messages: [{ role: "user", content: "x" }] },
    });
    expect(out.status).toBe(202);
    // It fails asynchronously with a reason, rather than dispatching to a
    // path that cannot serve it.
    const deadline = Date.now() + 5000;
    let job: any = null;
    while (Date.now() < deadline) {
      job = (await call(h, "GET", `/v1/jobs/${out.body.job_id}`)).body;
      if (["failed", "done", "cancelled"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job.status).toBe("failed");
    expect(job.error.message).toMatch(/local helper/);
  });
});

describe("structured output reaches the IR", () => {
  it("maps a JSON Schema response_format into the bridge type spellings", () => {
    // The bridge compiles these into Python dataclass annotations, so
    // `{"type":"string"}` is not usable — it has to arrive as `str`.
    const req = decodeOpenAiRequest({
      model: "nanites-needle-extract",
      messages: [{ role: "user", content: "Order 8812" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: {
            type: "object",
            properties: {
              order_id: { type: "integer" },
              total: { type: "number" },
              city: { type: "string" },
              urgent: { type: "boolean" },
            },
            required: ["order_id", "total", "city", "urgent"],
          },
        },
      },
    });
    expect(req.output_schema).toEqual({ order_id: "int", total: "float", city: "str", urgent: "bool" });
    expect(req.response_format).toBeDefined();
  });

  it("drops optional fields, because the dataclass cannot express optional", () => {
    const req = decodeOpenAiRequest({
      model: "m", messages: [{ role: "user", content: "x" }],
      response_format: {
        json_schema: {
          schema: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
            required: ["a"],
          },
        },
      },
    });
    expect(req.output_schema).toEqual({ a: "str" });
  });

  it("accepts the flat spelling the bridge takes directly", () => {
    const req = decodeOpenAiRequest({
      model: "m", messages: [{ role: "user", content: "x" }],
      response_format: { schema: { city: "str", total: "float" } },
    });
    expect(req.output_schema).toEqual({ city: "str", total: "float" });
  });

  it("reads a declared output modality and rejects a bad one", () => {
    const ok = decodeAnthropicRequest({
      model: "m", max_tokens: 16, output_modality: "image",
      messages: [{ role: "user", content: "a cat" }],
    });
    expect(ok.output_modality).toBe("image");
    let threw = false;
    try {
      decodeAnthropicRequest({
        model: "m", max_tokens: 16, output_modality: "hologram",
        messages: [{ role: "user", content: "a cat" }],
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
  });
});
