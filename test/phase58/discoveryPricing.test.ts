/**
 * Phase 58 gate — pricing on discovery, not only on seed.
 *
 * Pricing reached the database through exactly one writer: the manifest seed.
 * A model discovered from the catalog — which already carries its rates in the
 * `price` property — was written with `pricing_prompt`/`pricing_completion` NULL,
 * so every run on it logged `cost_usd = NULL` and the cost report quietly read
 * that as zero. The pre-fix exit worked around this by re-seeding the fleet by
 * hand; this suite is what makes that workaround unnecessary.
 *
 * The destructive case is the one to hold: a re-discovery that publishes no
 * price must not erase a rate that is already on the row.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync as Sqlite } from "node:sqlite";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { CloudflareClient, OpenRouterClient } from "../../src/providers/client.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderCallLogStore } from "../../src/storage/providerCallLogStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { routeCloudWithRetry } from "../../src/providers/router.js";
import { getCostSavedReport } from "../../src/workflows/costSavedReport.js";
import { CLOUDFLARE_AGENT_MANIFEST } from "../../src/seed/cloudflareAgentManifest.js";
import { scratchHome } from "../phase3/helpers.js";

const CF = "cloudflare";
/** A real catalog row the seed manifest does not cover (the catalog fixture
 * marks it as a decoy) — the exact shape the pre-fix exit had to fix by hand. */
const UNSEEDED = "@cf/moonshotai/kimi-k2.7-code";
/** Manifest-seeded, and seeded at the same rates the discovery fixture uses. */
const SEEDED = "@cf/ibm-granite/granite-4.0-h-micro";
const RATES = { input: 0.017, output: 0.112 };
const UNPRICED_A = "@cf/meta/llama-3.1-8b-instruct";
const UNPRICED_B = "@cf/mistralai/mistral-7b-instruct-v0.2";

function harness(name: string): ToolDeps {
  const d = buildDeps(scratchHome());
  d.profiles.createProfile({ name });
  d.profiles.switchProfile(name);
  new ProviderKeyStore(d.db).addKey(name, CF, "sk-live-key", { accountId: "acct-0" });
  return d;
}

/** The catalog's price property, in the shape `/ai/models/search` returns. */
function catalogItem(id: string, price?: Array<{ unit: string; price: number }>): Record<string, unknown> {
  return {
    id: `uuid-${id}`,
    name: id,
    context_length: 131_072,
    ...(price ? { properties: [{ property_id: "price", value: price }] } : {}),
  };
}

function stubCatalog(items: Array<Record<string, unknown>>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ success: true, result: items }),
    text: async () => "",
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** One healthy cloud answer, with usage big enough to price in whole dollars. */
function stubChat(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      id: "req-1",
      choices: [{ message: { role: "assistant", content: "answered" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    }),
    text: async () => "",
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("Phase 58 — discovery carries the catalog price", () => {
  it("maps the price property onto both rates", async () => {
    const r = stubCatalog([
      catalogItem(UNSEEDED, [
        { unit: "per M input tokens", price: RATES.input },
        { unit: "per M output tokens", price: RATES.output },
      ]),
    ]);
    try {
      const models = (await new CloudflareClient().listModels("k", "acct-0")).models;
      expect(models[0]!.pricing_prompt).toBeCloseTo(RATES.input, 6);
      expect(models[0]!.pricing_completion).toBeCloseTo(RATES.output, 6);
    } finally {
      r();
    }
  });

  it("leaves both rates undefined when the catalog publishes no price", async () => {
    const r = stubCatalog([catalogItem(UNSEEDED)]);
    try {
      const models = (await new CloudflareClient().listModels("k", "acct-0")).models;
      expect(models[0]!.pricing_prompt ?? null).toBeNull();
      expect(models[0]!.pricing_completion ?? null).toBeNull();
    } finally {
      r();
    }
  });

  it("prices a discovered model's ledger row like the seeded equivalent", async () => {
    const d = harness("ph58-ledger-price");
    const models = new ProviderModelStore(d.db);
    // The premise: this model has no manifest entry, so discovery is its only
    // route to a price.
    expect(CLOUDFLARE_AGENT_MANIFEST.some((m) => m.model_id === UNSEEDED)).toBe(false);

    const r = stubCatalog([
      catalogItem(UNSEEDED, [
        { unit: "per M input tokens", price: RATES.input },
        { unit: "per M output tokens", price: RATES.output },
      ]),
    ]);
    try {
      const discovered = (await new CloudflareClient().listModels("k", "acct-0")).models;
      models.upsertModels("ph58-ledger-price", CF, discovered);
    } finally {
      r();
    }
    models.registerManifestModel("ph58-ledger-price", CF, {
      model_id: SEEDED, context_length: 131_000, vision: false, function_calling: true,
      pricing_prompt: RATES.input, pricing_completion: RATES.output,
    });

    restore = stubChat();
    const profile = d.profiles.getProfile("ph58-ledger-price")!;
    for (const model of [UNSEEDED, SEEDED]) {
      await routeCloudWithRetry(
        { profile, db: d.db as Sqlite, effort: "medium", role: "reviewer", brief: "hi", messages: [{ role: "user", content: "hi" }] },
        CF,
        model,
      );
    }

    const ledger = new ProviderCallLogStore(d.db).listRecent("ph58-ledger-price");
    const discoveredRow = ledger.find((row) => row.model_id === UNSEEDED)!;
    const seededRow = ledger.find((row) => row.model_id === SEEDED)!;
    // 1M in + 1M out at the discovered rates.
    expect(discoveredRow.cost_usd).toBeCloseTo(RATES.input + RATES.output, 6);
    expect(discoveredRow.cost_usd).toBeCloseTo(seededRow.cost_usd!, 6);
    d.close();
  });

  it("writes null when neither discovery nor the manifest prices the model", async () => {
    const d = harness("ph58-ledger-noprice");
    const r = stubCatalog([catalogItem(UNSEEDED)]);
    try {
      const discovered = (await new CloudflareClient().listModels("k", "acct-0")).models;
      new ProviderModelStore(d.db).upsertModels("ph58-ledger-noprice", CF, discovered);
    } finally {
      r();
    }

    restore = stubChat();
    await routeCloudWithRetry(
      {
        profile: d.profiles.getProfile("ph58-ledger-noprice")!,
        db: d.db as Sqlite, effort: "medium", role: "reviewer", brief: "hi", messages: [{ role: "user", content: "hi" }],
      },
      CF,
      UNSEEDED,
    );

    expect(new ProviderCallLogStore(d.db).listRecent("ph58-ledger-noprice")[0]!.cost_usd).toBeNull();
    d.close();
  });
});

describe("Phase 58 — a re-discovery cannot erase a seeded price", () => {
  it("keeps the existing rates when the catalog supplies none", () => {
    const d = harness("ph58-no-clobber");
    const models = new ProviderModelStore(d.db);
    models.registerManifestModel("ph58-no-clobber", CF, {
      model_id: UNSEEDED, context_length: null, vision: false, function_calling: true,
      pricing_prompt: RATES.input, pricing_completion: RATES.output,
    });

    models.upsertModels("ph58-no-clobber", CF, [{ id: UNSEEDED, name: UNSEEDED, owned_by: "cloudflare" }]);

    const row = models.getModel("ph58-no-clobber", CF, UNSEEDED)!;
    expect(row.pricing_prompt).toBeCloseTo(RATES.input, 6);
    expect(row.pricing_completion).toBeCloseTo(RATES.output, 6);
    d.close();
  });

  it("refreshes the rates when the catalog does supply them", () => {
    const d = harness("ph58-refresh");
    const models = new ProviderModelStore(d.db);
    models.registerManifestModel("ph58-refresh", CF, {
      model_id: UNSEEDED, context_length: null, vision: false, function_calling: true,
      pricing_prompt: 9.99, pricing_completion: 9.99,
    });

    models.upsertModels("ph58-refresh", CF, [
      { id: UNSEEDED, name: UNSEEDED, owned_by: "cloudflare", pricing_prompt: 0.25, pricing_completion: 0.5 },
    ]);

    const row = models.getModel("ph58-refresh", CF, UNSEEDED)!;
    expect(row.pricing_prompt).toBeCloseTo(0.25, 6);
    expect(row.pricing_completion).toBeCloseTo(0.5, 6);
    d.close();
  });

  it("re-seeding the manifest still overwrites both rates", () => {
    const d = harness("ph58-manifest-authority");
    const models = new ProviderModelStore(d.db);
    models.upsertModels("ph58-manifest-authority", CF, [
      { id: UNSEEDED, name: UNSEEDED, owned_by: "cloudflare", pricing_prompt: 0.25, pricing_completion: 0.5 },
    ]);

    models.registerManifestModel("ph58-manifest-authority", CF, {
      model_id: UNSEEDED, context_length: null, vision: false, function_calling: true,
      pricing_prompt: RATES.input, pricing_completion: RATES.output,
    });

    const row = models.getModel("ph58-manifest-authority", CF, UNSEEDED)!;
    expect(row.pricing_prompt).toBeCloseTo(RATES.input, 6);
    expect(row.pricing_completion).toBeCloseTo(RATES.output, 6);
    d.close();
  });
});

describe("Phase 58 — the report names the models it cannot price", () => {
  it("counts registered models with no output rate, and drops to zero once priced", () => {
    const d = harness("ph58-unpriced");
    const models = new ProviderModelStore(d.db);
    models.registerModel("ph58-unpriced", CF, UNPRICED_A);
    models.registerModel("ph58-unpriced", CF, UNPRICED_B);
    models.registerManifestModel("ph58-unpriced", CF, {
      model_id: SEEDED, context_length: null, vision: false, function_calling: true,
      pricing_prompt: RATES.input, pricing_completion: RATES.output,
    });

    expect(getCostSavedReport(d, "ph58-unpriced").unpriced_models).toBe(2);

    models.upsertModels("ph58-unpriced", CF, [
      { id: UNPRICED_A, owned_by: "cloudflare", pricing_prompt: 0.1, pricing_completion: 0.2 },
      { id: UNPRICED_B, owned_by: "cloudflare", pricing_prompt: 0.3, pricing_completion: 0.4 },
    ]);

    expect(getCostSavedReport(d, "ph58-unpriced").unpriced_models).toBe(0);
    d.close();
  });
});

describe("Phase 58 — OpenAI-shaped discovery is unchanged", () => {
  it("OpenRouter models carry no pricing fields and store nulls", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ data: [{ id: "openai/gpt-4o-mini", context_length: 128_000 }] }),
      text: async () => "",
    })) as unknown as typeof fetch;

    try {
      const models = (await new OpenRouterClient().listModels("k")).models;
      expect(models[0]!.pricing_prompt).toBeUndefined();
      expect(models[0]!.pricing_completion).toBeUndefined();

      const d = harness("ph58-openrouter");
      new ProviderModelStore(d.db).upsertModels("ph58-openrouter", "openrouter", models);
      const row = new ProviderModelStore(d.db).getModel("ph58-openrouter", "openrouter", "openai/gpt-4o-mini")!;
      expect(row.pricing_prompt).toBeNull();
      expect(row.pricing_completion).toBeNull();
      d.close();
    } finally {
      globalThis.fetch = original;
    }
  });
});
