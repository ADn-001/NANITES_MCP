/**
 * R4 — alias chains and the advertised catalog.
 *
 * `walkChain` is a pure function over a send closure, so the walking rules are
 * testable with no database and no provider. That matters because the rules
 * are the whole point: which failures a chain absorbs, and which it must
 * propagate, is exactly the distinction between a chain that makes a service
 * more reliable and one that hides a real outage behind four times the latency.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { ROUTER_PROFILE } from "../../src/router/constants.js";
import { walkChain, isRealAnswer, isWalkable, setAlias, getAlias, listAliases, deleteAlias, setStickyWinner, type ChainCandidate } from "../../src/router/models/aliases.js";
import { setAdvertised, listAdvertised, getAdvertised, deleteAdvertised, renderOpenAiCatalog, renderAnthropicCatalog } from "../../src/router/models/catalog.js";
import { NanitesError } from "../../src/helpers/errors.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];
let restoreFetch: (() => void) | null = null;

const CANDIDATES: ChainCandidate[] = [
  { provider: "openrouter", model_id: "a" },
  { provider: "openrouter", model_id: "b" },
  { provider: "openrouter", model_id: "c" },
];

function err(code: string): NanitesError {
  return new NanitesError({ code, message: `simulated ${code}`, retryable: true });
}

describe("isRealAnswer", () => {
  it("accepts text, parts, and tool calls", () => {
    expect(isRealAnswer({ content: "hi" })).toBe(true);
    expect(isRealAnswer({ content: [{ type: "text", text: "x" }] })).toBe(true);
    expect(isRealAnswer({ content: "", tool_calls: [{ id: "1" }] })).toBe(true);
  });

  it("rejects empty answers, including whitespace-only", () => {
    // An empty completion is NOT a success. Treating it as one would pin a
    // chain to a model that answers with nothing.
    expect(isRealAnswer({ content: "" })).toBe(false);
    expect(isRealAnswer({ content: "   \n " })).toBe(false);
    expect(isRealAnswer({ content: [] })).toBe(false);
    expect(isRealAnswer({ content: "", tool_calls: [] })).toBe(false);
  });
});

describe("walkChain", () => {
  it("returns the FIRST candidate's answer and never calls the rest", async () => {
    const called: number[] = [];
    const out = await walkChain("a", CANDIDATES, 0, async (_c, i) => {
      called.push(i);
      return { content: "first" };
    });
    expect(out.winner).toBe(0);
    expect(out.tried).toBe(1);
    // Stop-on-first-success: candidates 1 and 2 must never be contacted.
    expect(called).toEqual([0]);
  });

  it("walks past a key-scoped failure to the next candidate", async () => {
    const called: number[] = [];
    const out = await walkChain("a", CANDIDATES, 0, async (_c, i) => {
      called.push(i);
      if (i === 0) throw err("provider_rate_limited");
      return { content: "second wins" };
    });
    expect(out.winner).toBe(1);
    expect(called).toEqual([0, 1]);
  });

  it("walks past an EMPTY answer and keeps going", async () => {
    const out = await walkChain("a", CANDIDATES, 0, async (_c, i) =>
      (i < 2 ? { content: "" } : { content: "third wins" }));
    expect(out.winner).toBe(2);
    expect(out.tried).toBe(3);
  });

  it("PROPAGATES a 5xx instead of walking", async () => {
    // A provider that 500s will 500 on every candidate. Walking would burn
    // three times the latency to return the same error, and hides the outage.
    const called: number[] = [];
    await expect(walkChain("a", CANDIDATES, 0, async (_c, i) => {
      called.push(i);
      throw err("provider_server_error");
    })).rejects.toMatchObject({ code: "provider_server_error" });
    expect(called).toEqual([0]);
  });

  it("PROPAGATES an unknown error rather than swallowing it", async () => {
    await expect(walkChain("a", CANDIDATES, 0, async () => {
      throw err("some_bug_we_never_classified");
    })).rejects.toMatchObject({ code: "some_bug_we_never_classified" });
  });

  it("throws chain_exhausted naming every reason when all candidates fail", async () => {
    try {
      await walkChain("flash", CANDIDATES, 0, async () => { throw err("provider_rate_limited"); });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as NanitesError;
      expect(err.code).toBe("chain_exhausted");
      expect(err.message).toContain("flash");
      expect((err.details?.["reasons"] as unknown[]).length).toBe(3);
    }
  });

  it("starts at the sticky winner, skipping known-bad candidates", async () => {
    const called: number[] = [];
    const out = await walkChain("a", CANDIDATES, 1, async (_c, i) => {
      called.push(i);
      return { content: "ok" };
    });
    // Starting at 1 means candidate 0 is never paid for again.
    expect(called).toEqual([1]);
    expect(out.winner).toBe(1);
  });

  it("wraps around past the end when the sticky winner is the last candidate", async () => {
    const called: number[] = [];
    // Start at the last candidate; it and the one after it fail, so the walk
    // must wrap to index 0 rather than running off the end.
    const out = await walkChain("a", CANDIDATES, 2, async (_c, i) => {
      called.push(i);
      if (i !== 1) throw err("provider_rate_limited");
      return { content: "wrapped" };
    });
    expect(called).toEqual([2, 0, 1]);
    expect(out.winner).toBe(1);
  });

  it("rejects an empty candidate list", async () => {
    await expect(walkChain("a", [], 0, async () => ({ content: "x" })))
      .rejects.toMatchObject({ code: "alias_unknown" });
  });
});

describe("walkability classification", () => {
  it("walks the transient/account codes and stops at the rest", () => {
    for (const code of [
      "provider_rate_limited", "provider_quota_exhausted", "provider_auth_error",
      "provider_model_not_found", "all_keys_exhausted", "provider_timeout",
    ]) expect(isWalkable(code)).toBe(true);

    for (const code of ["provider_server_error", "provider_gateway_error", "bad_request", "router_invalid_request"]) {
      expect(isWalkable(code)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------ persistence */

/**
 * Open a router so the persistence tests have a real database.
 *
 * Only the DB and the stores are needed here — nothing is dispatched — but the
 * database is only reachable through the router's deps, so a real server is
 * started rather than a hand-rolled one that could drift from the real schema.
 */
async function harness() {
  const h = scratchHome();
  homes.push(h);
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  const db = handle.deps.db;
  return {
    db,
    keyStore: new ProviderKeyStore(db),
    modelStore: new ProviderModelStore(db),
    key: handle.deps.generatedKey!,
    port: handle.port,
  };
}

function seedModels(modelStore: ProviderModelStore, ids: string[], provider = "openrouter"): void {
  for (const id of ids) modelStore.registerModel(ROUTER_PROFILE, provider as never, id);
}

describe("alias persistence", () => {
  it("rejects a candidate that is not in the catalog AT WRITE TIME", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["known"]);
    // Validating lazily is the mistake the registry already made once: the
    // operator should see this now, not on a request three days from now.
    let code: string | null = null;
    try {
      setAlias(h.db, "flash", [{ provider: "openrouter", model_id: "never-discovered" }]);
    } catch (e) { code = (e as NanitesError).code; }
    expect(code).toBe("alias_candidate_unknown");
    // And nothing was written.
    expect(listAliases(h.db)).toHaveLength(0);
  });

  it("accepts a fully valid chain and round-trips it", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["a", "b"]);
    const def = setAlias(h.db, "nanites-flash", [
      { provider: "openrouter", model_id: "a" },
      { provider: "openrouter", model_id: "b" },
    ]);
    expect(def.alias).toBe("nanites-flash");
    expect(def.sticky_winner).toBeNull();
    expect(getAlias(h.db, "nanites-flash")!.candidates).toHaveLength(2);
  });

  it("rejects an empty candidate list", async () => {
    const h = await harness();
    expect(() => setAlias(h.db, "x", [])).toThrow(/at least one/);
  });

  it("replaces an alias and clears its sticky winner", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["a", "b"]);
    setAlias(h.db, "f", [{ provider: "openrouter", model_id: "a" }]);
    setStickyWinner(h.db, "f", 0);
    expect(getAlias(h.db, "f")!.sticky_winner).toBe(0);
    setAlias(h.db, "f", [{ provider: "openrouter", model_id: "b" }]);
    // A new chain invalidates the old winner's index.
    expect(getAlias(h.db, "f")!.sticky_winner).toBeNull();
  });

  it("deletes an alias", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["a"]);
    setAlias(h.db, "f", [{ provider: "openrouter", model_id: "a" }]);
    expect(deleteAlias(h.db, "f")).toBe(true);
    expect(getAlias(h.db, "f")).toBeNull();
  });
});

describe("advertised catalog", () => {
  it("returns ONLY the advertised subset", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["m1", "m2", "m3", "m4", "m5"]);
    setAdvertised(h.db, { alias: "nanites-flash", realId: "m1", provider: "openrouter" });
    setAdvertised(h.db, { alias: "nanites-pro", realId: "m5", provider: "openrouter" });
    // A catalog of 5, two published. A harness pinging /v1/models must not
    // receive the three the operator chose not to expose.
    expect(listAdvertised(h.db)).toHaveLength(2);
  });

  it("rejects an alias containing a colon, slash, or whitespace", async () => {
    // The whole point of the feature: a name the harness will accept.
    const h = await harness();
    seedModels(h.modelStore, ["m1"]);
    for (const bad of ["qwen/qwen3.8-27b:free", "has space", "a:b"]) {
      expect(() => setAdvertised(h.db, { alias: bad, realId: "m1", provider: "openrouter" }))
        .toThrow(/may not contain/);
    }
  });

  it("rejects publishing a model that was never discovered", async () => {
    const h = await harness();
    let code: string | null = null;
    try {
      setAdvertised(h.db, { alias: "ghost", realId: "never", provider: "openrouter" });
    } catch (e) { code = (e as NanitesError).code; }
    expect(code).toBe("alias_candidate_unknown");
  });

  it("renders both dialects with the SAFE alias as the id", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["qwen/qwen3.8-27b:free"]);
    setAdvertised(h.db, { alias: "nanites-flash", realId: "qwen/qwen3.8-27b:free", provider: "openrouter" });
    const models = listAdvertised(h.db);

    const openai = renderOpenAiCatalog(models) as { data: Array<{ id: string }> };
    // The published id is what a client sees, NOT the slash-and-colon real id.
    expect(openai.data[0]!.id).toBe("nanites-flash");
    expect(JSON.stringify(openai)).not.toContain("qwen/qwen3.8-27b");

    const anthropic = renderAnthropicCatalog(models) as { data: Array<{ id: string; type: string }> };
    expect(anthropic.data[0]!.id).toBe("nanites-flash");
    expect(anthropic.data[0]!.type).toBe("model");
  });

  it("deletes an advertised model", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["m1"]);
    setAdvertised(h.db, { alias: "f", realId: "m1", provider: "openrouter" });
    expect(deleteAdvertised(h.db, "f")).toBe(true);
    expect(getAdvertised(h.db, "f")).toBeNull();
  });
});

describe("advertised catalog over HTTP", () => {
  it("serves /v1/models in the caller's dialect, with only advertised entries", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["real-a", "real-b", "hidden-c"]);
    setAdvertised(h.db, { alias: "nanites-flash", realId: "real-a", provider: "openrouter" });
    setAdvertised(h.db, { alias: "nanites-pro", realId: "real-b", provider: "openrouter" });
    const base = `http://127.0.0.1:${h.port}/v1/models`;

    const openai = await fetch(base, { headers: { authorization: `Bearer ${h.key}` } });
    const oa = (await openai.json()) as { object: string; data: Array<{ id: string }> };
    expect(oa.object).toBe("list");
    expect(oa.data.map((m) => m.id).sort()).toEqual(["nanites-flash", "nanites-pro"]);
    // "hidden-c" was never advertised and must not appear.
    expect(JSON.stringify(oa)).not.toContain("hidden-c");

    const anthropic = await fetch(base, {
      headers: { authorization: `Bearer ${h.key}`, "anthropic-version": "2023-06-01" },
    });
    const an = (await anthropic.json()) as { data: Array<{ type: string; id: string }>; has_more: boolean };
    expect(an.data[0]!.type).toBe("model");
    expect(an.data.map((m) => m.id).sort()).toEqual(["nanites-flash", "nanites-pro"]);
    expect(an.has_more).toBe(false);
  });

  it("requires the virtual key on /v1/models", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["m"]);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/models`);
    expect(res.status).toBe(401);
  });

  it("resolves an advertised alias to its real model on the inference path", async () => {
    const h = await harness();
    seedModels(h.modelStore, ["real-a"]);
    setAdvertised(h.db, { alias: "nanites-flash", realId: "real-a", provider: "openrouter" });
    // The alias resolves; the failure is "no key", NOT "unknown model", which
    // is what proves the resolution step ran before dispatch.
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.key}` },
      body: JSON.stringify({ model: "nanites-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).not.toBe("alias_unknown");
  });
});

afterEach(async () => {
  restoreFetch?.();
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});
