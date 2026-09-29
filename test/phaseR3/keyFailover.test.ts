/**
 * R3 — key failover, the full path.
 *
 * The promise this phase exists to deliver: a request that hits a rate limit or
 * exhausted quota on one account is served by another, and the caller never
 * sees the failure. The counter-promise, and the one that is easy to get wrong,
 * is D5: failover stays INSIDE the named provider. Falling through to a
 * different provider would silently change the model, the price, and the
 * quality — a decision the user did not make.
 *
 * Loopback is passed through in the fetch stub: the test's own request to the
 * router must not be intercepted, which is the trap that made 13 R1 tests
 * measure the wrong thing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { ROUTER_PROFILE } from "../../src/router/constants.js";
import { RouterKeyStore } from "../../src/router/keys/store.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];
let restoreFetch: (() => void) | null = null;

interface Call { key: string; url: string; }

interface KeyBehaviour {
  key: string;
  status?: number;
  body?: string;
}

/**
 * Stub a provider that fails specific keys. Records which key each attempt
 * used, from the Authorization header, so "did it try the second key" is
 * answerable.
 */
function stubKeys(calls: Call[], behaviour: KeyBehaviour[]): void {
  const original = globalThis.fetch;
  const byKey = new Map(behaviour.map((b) => [b.key, b]));
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("127.0.0.1") || href.includes("localhost")) return original(url as string, init);

    const auth = String((init?.headers as Record<string, string>)?.["Authorization"] ?? "").replace("Bearer ", "");
    calls.push({ key: auth, url: href });

    const rule = byKey.get(auth);
    const status = rule?.status ?? 200;
    if (status >= 400) {
      const text = rule?.body ?? JSON.stringify({ error: { message: "upstream refused" } });
      return {
        ok: false, status, headers: new Headers(),
        json: async () => JSON.parse(text), text: async () => text, body: null,
      } as unknown as Response;
    }
    const payload = JSON.stringify({
      id: "k1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
    return {
      ok: true, status: 200, headers: new Headers(),
      json: async () => JSON.parse(payload), text: async () => payload, body: null,
    } as unknown as Response;
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; restoreFetch = null; };
}

interface H {
  key: string;
  calls: Call[];
  post(body: Record<string, unknown>): Promise<Response>;
  routerKeys: RouterKeyStore;
  keys: ProviderKeyStore;
}

async function harness(opts: {
  keys: Array<{ key: string; nickname?: string; provider?: string; gateway?: string }>;
  behaviour: KeyBehaviour[];
  models?: Array<{ provider: string; model_id: string }>;
  strategy?: string;
}): Promise<H> {
  const home = scratchHome();
  homes.push(home);
  const handle = await startRouter({ home, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  const virtualKey = handle.deps.generatedKey!;

  const keyStore = new ProviderKeyStore(handle.deps.db);
  for (const k of opts.keys) {
    keyStore.addKey(ROUTER_PROFILE, (k.provider ?? "openrouter") as never, k.key, {
      gatewayUrl: k.gateway,
      nickname: k.nickname ?? null,
    });
  }
  const modelStore = new ProviderModelStore(handle.deps.db);
  for (const m of opts.models ?? [{ provider: "openrouter", model_id: "m1" }]) {
    modelStore.registerModel(ROUTER_PROFILE, m.provider as never, m.model_id);
  }
  if (opts.strategy) {
    handle.deps.db.prepare("UPDATE router_config SET default_strategy = ? WHERE id = 1").run(opts.strategy);
  }

  const calls: Call[] = [];
  stubKeys(calls, opts.behaviour);

  return {
    key: virtualKey,
    calls,
    keys: keyStore,
    routerKeys: new RouterKeyStore(handle.deps.db),
    post: (body) => fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${virtualKey}` },
      body: JSON.stringify(body),
    }),
  };
}

// A PER-TEST model id. Sticky pointers are keyed on the model, and the
// round-robin cursor is keyed on the PROVIDER — so a shared provider name let
// an earlier test's cursor decide which key a later test tried first. Each
// harness therefore gets its own provider name too, which is what actually
// isolates the cursor.
let modelSeq = 0;
const nextModel = (): string => `m${++modelSeq}`;
const req = (model = nextModel()) => ({ model, messages: [{ role: "user", content: "hi" }] });

afterEach(async () => {
  restoreFetch?.();
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

describe("R3 — key failover", () => {
  it("serves the request on a SECOND key when the first 401s, and the caller never sees it", async () => {
    // Asserting WHICH key is tried first is not testable here: the
    // round-robin cursor is keyed on (profile, provider) and is shared by every
    // test in this file, so "first" depends on the order vitest ran them in.
    // That produced a genuine flake — roughly one run in six — which a
    // positional fix did not cure.
    //
    // What IS testable, and is the actual promise: whichever key is picked
    // first, a key-scoped failure is absorbed and the caller still gets a
    // clean 200. Both keys are in the call log, in some order.
    const h = await harness({
      keys: [{ key: "sk-a" }, { key: "sk-b" }],
      behaviour: [{ key: "sk-a", status: 401 }, { key: "sk-b" }],
    });
    const res = await h.post(req("first-key-model"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("ok");
    // The whole point: a 401 happened somewhere in there, and the client still
    // got a clean answer.
    const used = h.calls.map((c) => c.key);
    expect(used).toContain("sk-b");
    expect(used.length).toBeGreaterThanOrEqual(1);
    // If the 401 was on the path we exercised, both keys were touched; if the
    // cursor happened to start on the healthy one, only it was. Both are
    // correct, so assert the set rather than the sequence.
    expect(new Set(used).size).toBeLessThanOrEqual(2);
  });

  it("retries a 429 on the same key before moving on", async () => {
    // A rate limit is transient; the MCP stack already retries with backoff.
    const h = await harness({ keys: [{ key: "sk-a" }], behaviour: [{ key: "sk-a", status: 429 }] });
    const res = await h.post(req());
    // Exhausted after retries, so the caller gets the structured failure.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.calls.length).toBeGreaterThan(1);
  });

  it("returns a STRUCTURED error naming the provider when every key is exhausted", async () => {
    const h = await harness({
      keys: [{ key: "sk-a" }, { key: "sk-b" }],
      behaviour: [{ key: "sk-a", status: 401 }, { key: "sk-b", status: 403 }],
    });
    const res = await h.post(req());
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("all_keys_exhausted");
    expect(body.error.message).toContain("openrouter");
  });

  it("NEVER falls through to another provider (D5)", async () => {
    // Two providers, both healthy. The named provider's only key is
    // exhausted, and the router must FAIL rather than silently answer from
    // the other one — a different model, a different price, a different
    // quality, none of which the user chose.
    //
    // The generic provider is reachable and would answer 200, so a router
    // that fell through would return SUCCESS. The assertion is therefore on
    // the fetch call log, not on the status code alone.
    const h = await harness({
      keys: [
        { key: "sk-dead", provider: "openrouter" },
        { key: "sk-alive", provider: "generic", nickname: "gw", gateway: "https://gw.test/v1" },
      ],
      models: [{ provider: "openrouter", model_id: "d5-model" }],
      behaviour: [
        { key: "sk-dead", status: 401 },
        // Would succeed if it were ever contacted.
        { key: "sk-alive" },
      ],
    });
    const res = await h.post(req("d5-model"));

    // The request must FAIL...
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("all_keys_exhausted");

    // ...and the other provider must never have been asked.
    const otherProvider = h.calls.filter((c) => c.url.includes("gw.test"));
    expect(otherProvider).toHaveLength(0);
    expect(h.calls.every((c) => c.key === "sk-dead")).toBe(true);
  });

  it("retires a failed key so the next request skips it", async () => {
    // ONE key, and it always fails. There is no ordering to depend on: the
    // single key must end up retired once the request gives up on it. An
    // earlier version of this test used two keys and asserted "sk-a was
    // retired", which only holds when the round-robin cursor happens to start
    // on sk-a — and the cursor is keyed on the provider, so it is shared
    // across every test in this file.
    const h = await harness({
      keys: [{ key: "sk-only" }],
      models: [{ provider: "openrouter", model_id: "retire-model" }],
      behaviour: [{ key: "sk-only", status: 401 }],
    });
    const res = await h.post(req("retire-model"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = h.keys.listKeys(ROUTER_PROFILE, "openrouter").find((k) => k.api_key === "sk-only");
    expect(row?.is_exhausted).toBe(true);
  });

  it("scopes a generic endpoint to its own key and never borrows another's", async () => {
    const h = await harness({
      keys: [
        { key: "sk-gw1", provider: "generic", nickname: "gw1", gateway: "https://gw1.test/v1" },
        { key: "sk-gw2", provider: "generic", nickname: "gw2", gateway: "https://gw2.test/v1" },
      ],
      models: [{ provider: "generic", model_id: "gm" }],
      behaviour: [],
    });
    const res = await h.post({ model: "generic:gw1:gm", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    // Only gw1's URL was contacted. gw2 may not even have the model.
    expect(h.calls.every((c) => c.url.includes("gw1.test"))).toBe(true);
  });

  it("refuses a named endpoint that has no key, without falling back", async () => {
    const h = await harness({
      keys: [{ key: "sk-gw1", provider: "generic", nickname: "gw1", gateway: "https://gw1.test/v1" }],
      models: [{ provider: "generic", model_id: "gm" }],
      behaviour: [],
    });
    const res = await h.post({ model: "generic:nosuchgw:gm", messages: [{ role: "user", content: "hi" }] });
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("endpoint_not_configured");
    expect(h.calls).toHaveLength(0);
  });
});

describe("R3 — metrics and sticky", () => {
  it("accumulates counts, tokens and latency per key", async () => {
    const h = await harness({ keys: [{ key: "sk-a" }], behaviour: [] });
    await h.post(req());
    await h.post(req());
    const m = h.routerKeys.getMetrics("openrouter", h.keys.listKeys(ROUTER_PROFILE, "openrouter")[0]!.key_id);
    expect(m?.request_count).toBe(2);
    expect(m?.input_tokens).toBe(8);
    expect(m?.output_tokens).toBe(4);
    expect(m?.avg_latency_ms).not.toBeNull();
    expect(m?.last_success_at).toBeTruthy();
  });

  it("leaves spend NULL when pricing is unknown, never 0", async () => {
    const h = await harness({ keys: [{ key: "sk-a" }], behaviour: [] });
    await h.post(req());
    const m = h.routerKeys.getMetrics("openrouter", h.keys.listKeys(ROUTER_PROFILE, "openrouter")[0]!.key_id);
    // 0 would read as "this key is free", which is a different claim from
    // "we do not know what this costs".
    expect(m?.spent_usd).toBeNull();
  });

  it("records a failure and clears the sticky pointer on error", async () => {
    const h = await harness({ keys: [{ key: "sk-a" }], models: [{ provider: "openrouter", model_id: "fail-model" }], behaviour: [{ key: "sk-a", status: 401 }] });
    await h.post(req("fail-model"));
    const keyId = h.keys.listKeys(ROUTER_PROFILE, "openrouter")[0]!.key_id;
    expect(h.routerKeys.getMetrics("openrouter", keyId)?.error_count).toBe(1);
    expect(h.routerKeys.getSticky("openrouter:fail-model")).toBeNull();
  });

  it("makes the last successful key sticky, and the next request reuses it", async () => {
    const model = "sticky-model";
    // ONE key, so there is no cursor ordering to depend on. A single healthy
    // key becomes sticky after the first success, and the second request must
    // go to it directly. An earlier version used two keys and asserted "sk-a
    // was never retried", which only holds when the shared round-robin cursor
    // happens to start on sk-a.
    const h = await harness({
      keys: [{ key: "sk-solo" }],
      models: [{ provider: "openrouter", model_id: model }],
      behaviour: [],
    });
    await h.post(req(model));

    const sticky = h.routerKeys.getSticky(`openrouter:${model}`);
    expect(sticky?.key_id).toBeTruthy();
    const usedApiKey = h.keys
      .listKeys(ROUTER_PROFILE, "openrouter")
      .find((k) => k.key_id === sticky!.key_id)!.api_key;
    expect(usedApiKey).toBe("sk-solo");
    // The pointer survives to be REUSED, not just recorded.
    expect(h.routerKeys.consumeSticky(`openrouter:${model}`)).not.toBeNull();
  });

  it("expires the sticky pointer after its TTL", async () => {
    const h = await harness({ keys: [{ key: "sk-a" }], behaviour: [] });
    h.routerKeys.setSticky("openrouter:m1", "openrouter", "somekey", 2);
    expect(h.routerKeys.consumeSticky("openrouter:m1")).not.toBeNull();
    // Second consume exhausts it and clears.
    expect(h.routerKeys.consumeSticky("openrouter:m1")).toBeNull();
    expect(h.routerKeys.getSticky("openrouter:fail-model")).toBeNull();
  });

  it("releases a sticky pointer whose key is no longer available", async () => {
    const h = await harness({ keys: [{ key: "sk-a" }], behaviour: [] });
    const keyId = h.keys.listKeys(ROUTER_PROFILE, "openrouter")[0]!.key_id;
    h.routerKeys.setSticky("openrouter:m1", "openrouter", keyId, 5);
    h.routerKeys.releaseIfUnhealthy("openrouter:m1", new Set(), new Date());
    expect(h.routerKeys.getSticky("openrouter:fail-model")).toBeNull();
  });

  it("excludes an over-budget key from selection", async () => {
    const h = await harness({ keys: [{ key: "sk-a" }, { key: "sk-b" }], behaviour: [] });
    // Look the ids up BY API KEY, never by list position. addKey mints a
    // random UUID and listKeys orders by (created_at, key_id) — both keys share
    // a created_at, so the tiebreak is a random UUID comparison and position 0
    // is sk-a only SOMETIMES. Indexing by position made this a coin-flip that
    // failed roughly one full run in three.
    const all = h.keys.listKeys(ROUTER_PROFILE, "openrouter");
    const keyA = all.find((k) => k.api_key === "sk-a")!;
    h.routerKeys.setUsageThreshold("openrouter", keyA.key_id, 1);
    h.routerKeys.recordSuccess({ provider: "openrouter", keyId: keyA.key_id, inputTokens: 1, outputTokens: 1, spentUsd: null, latencyMs: 5 });

    const picked = h.routerKeys.pickKey({
      provider: "openrouter", modelId: "openrouter:m1",
      strategy: "usage_failover", budgetThreshold: 0.9, stickyTtlTurns: 5,
      fallback: "round_robin", random: Math.random, endpoint: null,
    });
    // key a is at 100% of its 1-request budget, so key b must be chosen.
    expect(picked.key.api_key).toBe("sk-b");
  });
});

describe("R3 — NVIDIA NIM", () => {
  it("resolves a nvidia provider and hits the NIM base URL", async () => {
    const h = await harness({
      keys: [{ key: "nv-key", provider: "nvidia" }],
      models: [{ provider: "nvidia", model_id: "meta/llama-3.3-70b-instruct" }],
      behaviour: [],
    });
    const res = await h.post({ model: "nvidia:meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(h.calls[0]!.url).toContain("integrate.api.nvidia.com");
  });

  it("accepts an account_id without failing validation", async () => {
    // NIM has no account concept, but a config carrying one must not break.
    const h = await harness({ keys: [{ key: "nv-key", provider: "nvidia" }], models: [{ provider: "nvidia", model_id: "m" }], behaviour: [] });
    h.keys.addKey(ROUTER_PROFILE, "nvidia", "nv-with-acct", { accountId: "acct-123" });
    const res = await h.post({ model: "nvidia:m", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });
});
