/**
 * Generic endpoints.
 *
 * `generic` is not one slot — it is many OpenAI-compatible gateways, each an
 * ordinary key row whose nickname is the endpoint's name and whose
 * gateway_url is its base URL. That already worked; what did not work is that
 * two gateways serving the SAME model id collided in the catalog
 * (provider_models is keyed by profile + provider + model_id), and that a call
 * could not be pinned to the gateway the model actually belongs to.
 *
 * The fix namespaces the stored id as `generic:<endpoint>:<model>`. Two
 * consequences are load-bearing and are what these cases pin:
 *
 *  - the namespace is stripped before the request leaves, because a gateway
 *    only knows its own model name, and
 *  - key rotation is scoped to the named endpoint, so a model is never sent to
 *    a gateway that does not have it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { routeCloudWithRetry } from "../../src/providers/router.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const PROFILE = "p-generic";
const homes: string[] = [];
const live: ToolDeps[] = [];

interface Wire {
  url: string;
  model: string;
  auth: string;
}

function stubFetch(wire: Wire[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    wire.push({
      url: String(url),
      model: String(body.model ?? ""),
      auth: String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", ""),
    });
    const payload = JSON.stringify({
      id: "r1",
      choices: [{ message: { role: "assistant", content: "answered" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    // The OpenAI-compatible clients read a streamed SSE body, so the stub has
    // to expose getReader() rather than json() — the earlier stub shape made
    // the reader blow up on `line.slice`.
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => JSON.parse(payload),
      text: async () => payload,
      // A real ReadableStream, because readSseLines() calls getReader() and
      // drives it asynchronously. A hand-rolled reader object is not enough.
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${payload}

`));
          controller.close();
        },
      }),
    } as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function harness(): ToolDeps {
  const home = scratchHome();
  homes.push(home);
  const d = buildDeps(home);
  live.push(d);
  d.profiles.createProfile({ name: PROFILE });
  d.profiles.switchProfile(PROFILE);
  return d;
}

/** Two generic gateways, each with its own key and its own base URL. */
function twoGateways(d: ToolDeps): void {
  const ks = new ProviderKeyStore(d.db);
  ks.addKey(PROFILE, "generic", "sk-codecraft", { gatewayUrl: "https://codecraftapi.test/v1", nickname: "codecraftapi" });
  ks.addKey(PROFILE, "generic", "sk-other", { gatewayUrl: "https://other.test/v1", nickname: "othergw" });
}

afterEach(() => {
  while (live.length) live.pop()!.close();
  while (homes.length) cleanup(homes.pop()!);
});

describe("generic endpoints", () => {
  it("strips the endpoint namespace before the request leaves", async () => {
    const d = harness();
    twoGateways(d);
    const wire: Wire[] = [];
    const restore = stubFetch(wire);

    await routeCloudWithRetry(
      { profile: d.profiles.getProfile(PROFILE)!, db: d.db, effort: "low", brief: "hi", role: "", messages: [{ role: "user", content: "hi" }] },
      "generic",
      "generic:codecraftapi:deepseek-v4-flash-0731",
    );

    restore();
    // The gateway must see its own model name, not the stored namespaced id.
    expect(wire).toHaveLength(1);
    expect(wire[0]!.model).toBe("deepseek-v4-flash-0731");
  });

  it("pins the call to the named endpoint's gateway and key", async () => {
    const d = harness();
    twoGateways(d);
    const wire: Wire[] = [];
    const restore = stubFetch(wire);

    await routeCloudWithRetry(
      { profile: d.profiles.getProfile(PROFILE)!, db: d.db, effort: "low", brief: "hi", role: "", messages: [{ role: "user", content: "hi" }] },
      "generic",
      "generic:othergw:deepseek-v4-flash-0731",
    );

    restore();
    expect(wire).toHaveLength(1);
    // Not merely the right model on the wire — the right GATEWAY and key.
    expect(wire[0]!.url).toContain("other.test");
    expect(wire[0]!.auth).toBe("sk-other");
  });

  it("refuses a model naming an endpoint that has no key, instead of trying another", async () => {
    const d = harness();
    twoGateways(d);
    const wire: Wire[] = [];
    const restore = stubFetch(wire);

    await expect(routeCloudWithRetry(
      { profile: d.profiles.getProfile(PROFILE)!, db: d.db, effort: "low", brief: "hi", role: "", messages: [{ role: "user", content: "hi" }] },
      "generic",
      "generic:nosuchgw:some-model",
    )).rejects.toMatchObject({ code: "endpoint_not_configured" });

    restore();
    // Crucially: it did not fall back to codecraftapi, which may not have the model.
    expect(wire).toHaveLength(0);
  });

  it("stores the same model id for two gateways as two catalog rows", () => {
    const d = harness();
    const ms = new ProviderModelStore(d.db);
    ms.registerModel(PROFILE, "generic", "generic:codecraftapi:deepseek-v4");
    ms.registerModel(PROFILE, "generic", "generic:othergw:deepseek-v4");

    const rows = ms.listModels(PROFILE, "generic", true);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.model_id).sort()).toEqual([
      "generic:codecraftapi:deepseek-v4",
      "generic:othergw:deepseek-v4",
    ]);
  });

  it("leaves an un-namespaced generic model free to rotate across keys", async () => {
    // The pre-existing behaviour: with no endpoint named there is nothing to
    // pin, so the normal rotation pool applies. This is what every existing
    // generic model id relies on and it must not regress.
    const d = harness();
    twoGateways(d);
    const wire: Wire[] = [];
    const restore = stubFetch(wire);

    await routeCloudWithRetry(
      { profile: d.profiles.getProfile(PROFILE)!, db: d.db, effort: "low", brief: "hi", role: "", messages: [{ role: "user", content: "hi" }] },
      "generic",
      "plain-model",
    );

    restore();
    expect(wire).toHaveLength(1);
    expect(wire[0]!.model).toBe("plain-model");
  });
});
