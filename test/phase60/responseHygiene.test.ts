/**
 * Phase 60 gate — dashboard response hygiene.
 *
 * Every case here is a route that returned something it should not have: an
 * unmasked token, a success message for work that never happened, upstream
 * error text, or a call the caller chose.
 */
import { describe, expect, it } from "vitest";
import { buildDeps } from "../../src/tools/deps.js";
import { startUiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";

async function setup() {
  const home = scratchHome();
  const deps = buildDeps(home, { healthDisk: { availableGb: 500 } });
  const mock = await startMockLmStudio(liveHandler);
  deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url }, machine_specs: { vram_gb: 4 } });
  deps.profiles.switchProfile("t");
  const ui = await startUiServer(deps, { port: 0 });
  return {
    deps,
    ui,
    mock,
    base: "http://127.0.0.1:" + ui.port,
    post: (p: string, b: unknown) =>
      fetch("http://127.0.0.1:" + ui.port + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      }),
  };
}

async function done(h: Awaited<ReturnType<typeof setup>>) {
  await h.ui.close();
  h.deps.close();
  await h.mock.close();
  cleanup(h.deps.home);
}

describe("unmasked profile", () => {
  it("returns the same projection from PATCH as from GET", async () => {
    // The bug was the PATCH handler returning the raw Profile object, which
    // exposed fields the GET projection never returns and, off-loopback, an
    // unmasked token. A loopback caller legitimately sees its own secrets —
    // that is the documented behavior of GET /api/profile — so the assertion
    // is that the two responses are identical, not that both are redacted.
    const h = await setup();
    h.deps.profiles.updateProfile("t", {
      endpoint: { url: "http://127.0.0.1:1", auth_token: "super-secret-value" },
    });
    const patched = (await (await h.post("/api/settings/profile", { dynamic_model: false })).json()) as {
      profile: Record<string, unknown>;
    };
    const fetched = (await (await fetch(h.base + "/api/profile?name=t")).json()) as {
      profile: Record<string, unknown>;
    };
    expect(patched.profile).toEqual(fetched.profile);
    expect(Object.keys(patched.profile).sort()).toEqual(Object.keys(fetched.profile).sort());
    await done(h);
  });

  it("does not leak provider prefs or other non-projection fields", async () => {
    const h = await setup();
    const res = await h.post("/api/settings/profile", { dynamic_model: false });
    const body = (await res.json()) as { profile: Record<string, unknown> };
    // The raw Profile also carries test_plan_ref and providers, which the
    // editor projection deliberately omits.
    expect(body.profile).not.toHaveProperty("test_plan_ref");
    expect(body.profile).not.toHaveProperty("created_at");
    await done(h);
  });
});

describe("provider config validation", () => {
  it("rejects a preference_order that is not an array of provider kinds", async () => {
    const h = await setup();
    const before = h.deps.profiles.getProfile("t")?.provider_preference_order;
    const res = await h.post("/api/providers/config", { preference_order: "cloudflare" });
    expect(res.status).toBe(400);
    expect(h.deps.profiles.getProfile("t")?.provider_preference_order).toEqual(before);
    await done(h);
  });

  it("rejects an unknown provider name in the order", async () => {
    const h = await setup();
    const res = await h.post("/api/providers/config", { preference_order: ["evil"] });
    expect(res.status).toBe(400);
    await done(h);
  });

  it("rejects an unknown key in provider_enabled", async () => {
    const h = await setup();
    const res = await h.post("/api/providers/config", { provider_enabled: { nope: { enabled: false } } });
    expect(res.status).toBe(400);
    await done(h);
  });

  it("persists a valid order", async () => {
    const h = await setup();
    const res = await h.post("/api/providers/config", { preference_order: ["openrouter", "cloudflare"] });
    expect(res.status).toBe(200);
    expect(h.deps.profiles.getProfile("t")?.provider_preference_order).toEqual(["openrouter", "cloudflare"]);
    await done(h);
  });
});

describe("provider key delete", () => {
  it("rejects a delete with no key_id instead of reporting a false success", async () => {
    const h = await setup();
    const res = await fetch(h.base + "/api/providers/keys?provider=cloudflare&op=remove", { method: "DELETE" });
    expect(res.status).toBe(400);
    await done(h);
  });

  it("404s an unknown key_id", async () => {
    const h = await setup();
    const res = await fetch(h.base + "/api/providers/keys?provider=cloudflare&op=remove&key_id=nope", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    await done(h);
  });
});

describe("provider ping SSRF", () => {
  it("refuses the cloud metadata address", async () => {
    const h = await setup();
    const res = await h.post("/api/providers/ping", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(res.status).toBe(400);
    await done(h);
  });

  it("refuses a loopback target", async () => {
    const h = await setup();
    const res = await h.post("/api/providers/ping", { url: "http://127.0.0.1:1234/v1/models" });
    expect(res.status).toBe(400);
    await done(h);
  });

  it("refuses a non-http scheme", async () => {
    const h = await setup();
    const res = await h.post("/api/providers/ping", { url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
    await done(h);
  });
});
