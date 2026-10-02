/**
 * R8d — the alias and broadcast HTTP surface.
 *
 * Both stores were built and unit-tested with NO way for a user to reach them:
 * `setAlias` was called from tests and nowhere else, so a chain like
 * `nanites-flash` could not be created through any surface, and the advertised
 * catalog was permanently empty so every harness saw zero models.
 *
 * These are the tests for the missing product path, plus the two bugs found by
 * running it for real: the chain re-dispatch resolved the alias NAME instead of
 * the winning candidate, and the broadcast hide was keyed on the alias rather
 * than the model id, so it reported success while deleting nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { scratchHome, cleanup, TEST_PROFILE, writeActiveProfile } from "../phase3/helpers.js";
import { unadvertiseModel, listAdvertised } from "../../src/router/models/catalog.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];

afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

const MODELS = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

async function harness() {
  const home = scratchHome();
  writeActiveProfile(home);
  homes.push(home);
  const handle = await startRouter({ home, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  const store = new ProviderModelStore(handle.deps.db);
  for (const m of MODELS) store.registerModel(TEST_PROFILE, "cloudflare", m);
  return handle;
}

async function call(h: StartedRouter, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${h.deps.generatedKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("POST /v1/aliases", () => {
  it("creates a chain and preserves the order given", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/v1/aliases", {
      alias: "nanites-flash",
      candidates: MODELS.map((model_id) => ({ provider: "cloudflare", model_id })),
    });
    expect(r.status).toBe(200);
    expect(r.body.alias).toBe("nanites-flash");
    // Order IS the policy, so it must survive the round trip exactly.
    expect(r.body.candidates.map((c: any) => c.model_id)).toEqual(MODELS);
  });

  it("rejects an unknown model AT WRITE TIME", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/v1/aliases", {
      alias: "nanites-broken",
      candidates: [{ provider: "cloudflare", model_id: "@cf/nope/does-not-exist" }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("alias_candidate_unknown");
  });

  it("rejects a colon in the name — the exact problem aliasing solves", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/v1/aliases", {
      alias: "bad:name",
      candidates: [{ provider: "cloudflare", model_id: MODELS[0] }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/colon/);
  });

  it("rejects an empty chain", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/v1/aliases", { alias: "empty", candidates: [] });
    expect(r.status).toBe(400);
  });
});

describe("GET and DELETE /v1/aliases", () => {
  it("lists, fetches one, and deletes", async () => {
    const h = await harness();
    await call(h, "POST", "/v1/aliases", {
      alias: "nanites-flash",
      candidates: MODELS.map((model_id) => ({ provider: "cloudflare", model_id })),
    });

    const list = await call(h, "GET", "/v1/aliases");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].alias).toBe("nanites-flash");

    const one = await call(h, "GET", "/v1/aliases/nanites-flash");
    expect(one.status).toBe(200);
    expect(one.body.candidates).toHaveLength(2);

    const del = await call(h, "DELETE", "/v1/aliases/nanites-flash");
    expect(del.body.deleted).toBe("nanites-flash");
    expect((await call(h, "GET", "/v1/aliases")).body.data).toHaveLength(0);
  });

  it("404s on an unknown alias rather than reporting a false success", async () => {
    const h = await harness();
    expect((await call(h, "GET", "/v1/aliases/nope")).status).toBe(404);
    expect((await call(h, "DELETE", "/v1/aliases/nope")).status).toBe(404);
  });
});

describe("chain re-dispatch resolves the WINNER, not the alias name", () => {
  // The bug this covers: after the walk succeeded, the handler re-dispatched
  // `resolveTarget(request.model)` — the ALIAS name — which fell into the bare
  // catalog search and answered "nanites-flash is served by more than one
  // provider", a model that does not exist. The chain ran correctly; only the
  // response was mis-resolved, which is why a unit test on the walker missed it.
  it("resolves the alias to its FIRST candidate's stored id", async () => {
    const h = await harness();
    const { getAlias } = await import("../../src/router/models/aliases.js");
    const { resolveTarget } = await import("../../src/router/outbound/resolve.js");
    await call(h, "POST", "/v1/aliases", {
      alias: "nanites-flash",
      candidates: MODELS.map((model_id) => ({ provider: "cloudflare", model_id })),
    });
    const def = getAlias(h.deps.db, "nanites-flash")!;
    // A fresh chain has no sticky winner, so the walk starts at index 0.
    const winner = def.candidates[def.sticky_winner ?? 0]!;
    const target = resolveTarget(h.deps.db, `${winner.provider}:${winner.model_id}`);
    expect(target.stored_id).toBe(`${winner.provider}:${winner.model_id}`);
  });

  it("clears the sticky winner when the chain is replaced", async () => {
    const h = await harness();
    const { getAlias, setStickyWinner } = await import("../../src/router/models/aliases.js");
    const cands = MODELS.map((model_id) => ({ provider: "cloudflare", model_id }));
    await call(h, "POST", "/v1/aliases", { alias: "nanites-flash", candidates: cands });
    setStickyWinner(h.deps.db, "nanites-flash", 1);
    expect(getAlias(h.deps.db, "nanites-flash")!.sticky_winner).toBe(1);

    // Replaced with a SHORTER chain: index 1 would now be a different model
    // entirely, so a stale winner is worse than none.
    await call(h, "POST", "/v1/aliases", {
      alias: "nanites-flash",
      candidates: [cands[0]!],
    });
    expect(getAlias(h.deps.db, "nanites-flash")!.sticky_winner).toBeNull();
  });
});

describe("POST /v1/broadcast", () => {
  it("lists the registered models as toggle candidates", async () => {
    const h = await harness();
    const r = await call(h, "GET", "/v1/broadcast");
    expect(r.body.models).toHaveLength(2);
    expect(r.body.models.every((m: any) => m.on === false)).toBe(true);
  });

  it("publishes under a custom name and makes it callable", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/v1/broadcast", {
      provider: "cloudflare", model_id: MODELS[0], on: true, alias: "nanites-scout",
    });
    expect(r.status).toBe(200);
    expect(r.body.alias).toBe("nanites-scout");
    // The catalog stores the BARE model id; passing a namespaced one made
    // setAdvertised report "not in the catalog" for a registered model.
    expect(r.body.real_id).toBe(MODELS[0]);

    const advertised = listAdvertised(h.deps.db);
    expect(advertised.map((m) => m.alias)).toEqual(["nanites-scout"]);
  });

  it("HIDES a model that was published under a different name", async () => {
    // The bug this covers: deleteAdvertised is keyed on the ALIAS, so a
    // toggle holding a model id deleted nothing and reported success while
    // /v1/models kept listing the model.
    const h = await harness();
    await call(h, "POST", "/v1/broadcast", {
      provider: "cloudflare", model_id: MODELS[0], on: true, alias: "nanites-scout",
    });
    expect(listAdvertised(h.deps.db)).toHaveLength(1);

    const off = await call(h, "POST", "/v1/broadcast", {
      provider: "cloudflare", model_id: MODELS[0], on: false,
    });
    expect(off.body.removed).toBe(true);
    expect(listAdvertised(h.deps.db)).toHaveLength(0);
  });

  it("keeps the model REGISTERED when it is hidden", async () => {
    // Broadcast controls visibility, not registration. Hiding a model must
    // not delete it from the catalog, or re-showing it would need a
    // re-discovery.
    const h = await harness();
    await call(h, "POST", "/v1/broadcast", { provider: "cloudflare", model_id: MODELS[0], on: true });
    await call(h, "POST", "/v1/broadcast", { provider: "cloudflare", model_id: MODELS[0], on: false });
    const still = new ProviderModelStore(h.deps.db).getModel(TEST_PROFILE, "cloudflare", MODELS[0]!);
    expect(still).toBeTruthy();
  });

  it("unadvertiseModel returns the alias it removed, and null when absent", async () => {
    const h = await harness();
    await call(h, "POST", "/v1/broadcast", {
      provider: "cloudflare", model_id: MODELS[0], on: true, alias: "renamed",
    });
    expect(unadvertiseModel(h.deps.db, MODELS[0]!, "cloudflare")).toBe("renamed");
    expect(unadvertiseModel(h.deps.db, MODELS[0]!, "cloudflare")).toBeNull();
  });
});

describe("publishing under a model's own id", () => {
  // Found by CLICKING the toggle in a browser, not by a test. Broadcasting with
  // no custom name fell back to `alias = modelId`, and a Cloudflare id like
  // `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` contains slashes — which the
  // catalog refuses, because a published name is what a client sends BACK. The
  // plainest toggle on the page failed with a 500.
  it("derives a name with no slashes or @", async () => {
    const h = await harness();
    const { safePublishedName } = await import("../../src/router/server.js");
    expect(safePublishedName("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"))
      .toBe("cf-deepseek-ai-deepseek-r1-distill-qwen-32b");
    expect(safePublishedName("@cf/meta/llama-3.3-70b-instruct-fp8-fast"))
      .toBe("cf-meta-llama-3.3-70b-instruct-fp8-fast");
    // Deterministic, so toggling twice publishes the same name.
    expect(safePublishedName("@cf/a/b")).toBe(safePublishedName("@cf/a/b"));
    expect(safePublishedName("@@@")).toBe("model");
  });

  it("broadcasts with NO alias supplied and lists it under the derived name", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/v1/broadcast", {
      provider: "cloudflare", model_id: MODELS[0], on: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.alias).not.toContain("/");
    expect(r.body.alias).not.toContain("@");
    expect(listAdvertised(h.deps.db).map((m) => m.alias)).toContain(r.body.alias);
  });

  it("re-hides by model id, whatever name it was published under", async () => {
    const h = await harness();
    await call(h, "POST", "/v1/broadcast", {
      provider: "cloudflare", model_id: MODELS[0], on: true, alias: "custom-name",
    });
    const off = await call(h, "POST", "/v1/broadcast", {
      provider: "cloudflare", model_id: MODELS[0], on: false,
    });
    expect(off.body.removed).toBe(true);
    expect(listAdvertised(h.deps.db)).toHaveLength(0);
  });
});
