/**
 * The shared provider surface: one implementation, used by both binaries.
 *
 * The duplication this file covers was real and had already drifted. The MCP
 * `discoverProviderModels` hardcoded the omniroute base URL while the router
 * honoured the key's `gateway_url`, so a key with a custom gateway listed
 * models for one caller and not the other — indistinguishable, from the
 * outside, from a provider that simply has no models.
 */
import { afterEach, describe, expect, it } from "vitest";
import { openNanitesDb, type NanitesDb } from "../../src/storage/db.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { discoveryBaseUrl, discoverModels } from "../../src/router/providers/discover.js";
import { providerKeyCounts, providerModelCounts } from "../../src/router/providers/inventory.js";
import { scratchHome, cleanup, TEST_PROFILE, writeActiveProfile } from "../phase3/helpers.js";

const homes: string[] = [];
const opened: NanitesDb[] = [];

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  while (homes.length) cleanup(homes.pop()!);
});

function db(): NanitesDb {
  const home = scratchHome();
  writeActiveProfile(home);
  homes.push(home);
  const o = openNanitesDb(home);
  opened.push(o);
  return o;
}

describe("discovery base URL", () => {
  const key = (gateway: string | null) => ({
    profile_name: TEST_PROFILE, provider: "generic" as const, key_id: "k",
    api_key: "x", account_id: null, gateway_url: gateway, nickname: null,
    is_enabled: true, is_exhausted: false, exhausted_until: null,
    consecutive_failures: 0, created_at: "2026-01-01T00:00:00.000Z",
  });

  it("honours the key's gateway_url for generic and omniroute", () => {
    // The bug, stated as a test. Both used to differ, and the MCP path was
    // the one that ignored the key.
    expect(discoveryBaseUrl("generic", key("https://my-gateway.example/v1")))
      .toBe("https://my-gateway.example/v1");
    expect(discoveryBaseUrl("omniroute", key("https://my-omni.example/v1")))
      .toBe("https://my-omni.example/v1");
  });

  it("falls back to the documented default when the key has no gateway", () => {
    expect(discoveryBaseUrl("generic", key(null))).toBe("http://localhost:8080/v1");
    expect(discoveryBaseUrl("omniroute", key(null))).toBe("http://localhost:20128/v1");
  });

  it("leaves the client default for the hosted providers", () => {
    expect(discoveryBaseUrl("cloudflare", key("https://ignored"))).toBeUndefined();
    expect(discoveryBaseUrl("openrouter", key("https://ignored"))).toBeUndefined();
  });
});

describe("discovery outcome", () => {
  it("reports a provider with no key rather than throwing", async () => {
    // A caller refreshing several providers must see which one failed. Throwing
    // here lost the batch to the first unreachable provider.
    const out = await discoverModels(db().db, "cloudflare", { profile: TEST_PROFILE });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("all_keys_exhausted");
  });

  it("names the missing account_id for Cloudflare", async () => {
    const d = db();
    new ProviderKeyStore(d.db).addKey(TEST_PROFILE, "cloudflare", "cf-token", {});
    const out = await discoverModels(d.db, "cloudflare", { profile: TEST_PROFILE });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("invalid_arguments");
      expect(out.message).toMatch(/account_id/);
    }
  });
});

describe("the inventory both surfaces read", () => {
  it("counts the same rows for the router and the dashboard", async () => {
    // The two used to be separate queries and DISAGREED: one filtered
    // is_enabled, the other did not, so the same database reported different
    // key counts depending on the tab.
    const d = db();
    const keys = new ProviderKeyStore(d.db);
    keys.addKey(TEST_PROFILE, "cloudflare", "a", { accountId: "x" });
    keys.addKey(TEST_PROFILE, "cloudflare", "b", { accountId: "y" });
    keys.addKey(TEST_PROFILE, "openrouter", "c", {});

    const routerView = providerKeyCounts(d.db);
    const uiView = providerKeyCounts(d.db);
    expect(routerView).toEqual(uiView);
    expect(routerView).toEqual([
      { provider: "cloudflare", keys: 2 },
      { provider: "openrouter", keys: 1 },
    ]);
  });

  it("excludes a disabled key by default and includes it on request", () => {
    const d = db();
    const keys = new ProviderKeyStore(d.db);
    keys.addKey(TEST_PROFILE, "cloudflare", "a", { accountId: "x" });
    keys.addKey(TEST_PROFILE, "cloudflare", "b", { accountId: "y" });
    d.db.prepare("UPDATE provider_api_keys SET is_enabled = 0 WHERE api_key = 'b'").run();

    expect(providerKeyCounts(d.db)).toEqual([{ provider: "cloudflare", keys: 1 }]);
    // The operator-facing endpoint reports what is CONFIGURED, which is a
    // different question from what is USABLE. Now an explicit argument rather
    // than an accident of which file the query was written in.
    expect(providerKeyCounts(d.db, { enabledOnly: false }))
      .toEqual([{ provider: "cloudflare", keys: 2 }]);
  });

  it("returns an empty list rather than throwing when nothing is configured", () => {
    expect(providerKeyCounts(db().db)).toEqual([]);
    expect(providerModelCounts(db().db)).toEqual([]);
  });
});
