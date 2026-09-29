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
import { helperStatus, guessModality, classifyReply } from "../../src/router/helpers/registry.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];

async function harness(enableHelpers = false) {
  const h = scratchHome();
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

  it("classifies a reply correctly with no helper", async () => {
    const h = await harness(false);
    expect(await classifyReply(h.deps.db, "here is your answer", false)).toBe("answer");
    // A tool call is unambiguous without a model.
    expect(await classifyReply(h.deps.db, "", true)).toBe("tool_call");
    // Empty is detectable by inspection.
    expect(await classifyReply(h.deps.db, "   ", false)).toBe("degenerate");
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
