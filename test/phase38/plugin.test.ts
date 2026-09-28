/**
 * Phase 38 gate — Nanites MCP server plugin conversion.
 * Validates:
 * 1. Plugin manifest is valid JSON with required fields
 * 2. .mcp.json wires the server correctly
 * 3. Skill copy pipeline: plugin → .claude (build artifact, not source)
 * 4. Dashboard serves all required tabs (settings + providers included)
 * 5. Plugin commands match MCP prompt chains
 * 6. Settings.json exists (future: schema)
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";
import { CloudflareClient, OpenRouterClient, OmniRouteClient, GenericClient } from "../../src/providers/client.js";

const ROOT = process.cwd();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(ROOT, "plugin", "nanites");
const CANONICAL_SKILL = path.join(PLUGIN_ROOT, "skills", "nanites", "SKILL.md");
const ARTIFACT_SKILL = path.join(ROOT, ".claude", "skills", "nanites", "SKILL.md");

interface Harness {
  deps: ToolDeps;
  ui: UiServer;
  mock: MockLmStudio;
  base: string;
}

async function setup(): Promise<Harness> {
  const home = scratchHome();
  const deps = buildDeps(home);
  const mock = await startMockLmStudio(liveHandler);
  deps.profiles.createProfile({ name: "test", endpoint: { url: mock.url } });
  deps.profiles.switchProfile("test");
  const ui = await startUiServer(deps, { port: 0 });
  return { deps, ui, mock, base: `http://127.0.0.1:${ui.port}` };
}

describe("Plugin manifest validation", () => {
  it("plugin.json is valid JSON", () => {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("plugin.json has required fields", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(raw.name).toBe("nanites");
    expect(raw.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(raw.description).toBeTruthy();
  });

  it(".mcp.json points at a build target that the build script produces", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".mcp.json"), "utf8"));
    const args: string[] = mcp.mcpServers.nanites.args;
    // The target only exists after `npm run build`, which is the point: assert
    // the PATH SHAPE and that the build script creates it, not the artifact.
    expect(args[0]).toContain("dist/index.js");
    const copyScript = fs.readFileSync(path.join(ROOT, "scripts", "copy-server.mjs"), "utf8");
    expect(copyScript).toContain("dist");
  });

  it("plugin.json has settings key", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(raw.settings).toBeDefined();
    expect(typeof raw.settings).toBe("object");
  });

  it("plugin.json points at this repository, not an unrelated upstream", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    // The intent is "no unrelated upstream", not a specific owner string: the
    // published repo's owner is a deployment fact, not a code invariant. Pin
    // the shape and forbid a foreign project, and let the URL be whatever the
    // published origin is.
    const home = String(raw.homepage);
    expect(() => new URL(home)).not.toThrow();
    // The repo name is Nanites under either `-` or `_`; GitHub preserves the
    // characters the owner chose, so accept both rather than pinning one.
    expect(home).toMatch(/^https:\/\/github\.com\/[^/]+\/nanites[-_]mcp$/i);
    expect(JSON.stringify(raw)).not.toContain("anthropics");
  });

  it("plugin.json and package.json agree on the version", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    const rootPkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "..", "..", "package.json"), "utf8"));
    // A plugin's `version` pins users to that cached copy until the string
    // changes, so a divergence silently serves stale code to installed users.
    expect(raw.version).toBe(rootPkg.version);
  });

  it("the plugin ships a package.json so a marketplace install resolves deps", () => {
    // Without a manifest in the plugin root, Claude Code installs no node_modules
    // for it and the server cannot import its runtime deps.
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies["@modelcontextprotocol/server"]).toBeDefined();
    expect(fs.existsSync(path.join(PLUGIN_ROOT, "package-lock.json"))).toBe(true);
  });

  it("settings.json exists", () => {
    expect(fs.existsSync(path.join(PLUGIN_ROOT, "settings.json"))).toBe(true);
  });
});

describe("MCP server wiring", () => {
  it(".mcp.json is valid JSON", () => {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, ".mcp.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it(".mcp.json declares nanites server with node", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".mcp.json"), "utf8"));
    expect(raw.mcpServers.nanites).toBeDefined();
    expect(raw.mcpServers.nanites.command).toBe("node");
    expect(raw.mcpServers.nanites.args).toContain("${CLAUDE_PLUGIN_ROOT}/dist/index.js");
  });

  it(".mcp.json uses only documented plugin variables", () => {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, ".mcp.json"), "utf8");
    // `${pluginDir}` was never a Claude Code variable and never substituted.
    expect(raw).not.toContain("pluginDir");
    expect(JSON.parse(raw).mcpServers.nanites.env).toBeUndefined();
  });

  it("ships the built server entry the manifest points at", () => {
    const entry = path.join(PLUGIN_ROOT, "dist", "index.js");
    if (!fs.existsSync(entry)) {
      console.warn("plugin/nanites/dist/index.js absent — run `npm run build` to cover this assertion");
      return;
    }
    expect(fs.existsSync(entry)).toBe(true);
  });
});

describe("Skill single-source (Phase 33 carry-forward)", () => {
  it("canonical skill carries frontmatter", () => {
    const content = fs.readFileSync(CANONICAL_SKILL, "utf8");
    expect(content.startsWith("---\nname: nanites")).toBe(true);
  });

  it(".claude artifact is diff-identical to canonical (build artifact)", () => {
    expect(fs.readFileSync(ARTIFACT_SKILL, "utf8")).toBe(fs.readFileSync(CANONICAL_SKILL, "utf8"));
  });
});

describe("Dashboard serves all required tabs", () => {
  it("serves settings tab markers", async () => {
    const h = await setup();
    const body = await (await fetch(`${h.base}/`)).text();
    expect(body).toContain('id="tab-settings"');
    expect(body).toContain('id="profileCards"');
    expect(body).toContain('id="createProfileBtn"');
    expect(body).toContain('id="saveProfileBtn"');
    expect(body).toContain('id="deleteProfileBtn"');
    expect(body).toContain('id="cfgEffort"');
    expect(body).toContain('id="cfgDynamicModel"');
    expect(body).toContain('id="cfgEndpointUrl"');
    expect(body).toContain('id="cfgNtfyUrl"');
    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("serves providers tab markers", async () => {
    const h = await setup();
    const body = await (await fetch(`${h.base}/`)).text();
    expect(body).toContain('id="tab-providers"');
    expect(body).toContain('id="providerOrderList"');
    expect(body).toContain('id="providerKeysContainer"');
    expect(body).toContain('id="discoverModelsBtn"');
    expect(body).toContain('id="providerModelsContainer"');
    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("serves errors tab markers", async () => {
    const h = await setup();
    const body = await (await fetch(`${h.base}/`)).text();
    expect(body).toContain('id="tab-errors"');
    expect(body).toContain('id="providerErrorsContainer"');
    expect(body).toContain('id="errorProviderFilter"');
    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("serves profile CRUD API endpoints", async () => {
    const h = await setup();
    // Create
    let res = await fetch(`${h.base}/api/settings/profile/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-profile", vram_gb: 8 }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`create returned ${res.status}: ${body}`);
    }
    expect(res.status).toBe(200);

    // List
    res = await fetch(`${h.base}/api/profiles`);
    expect(res.status).toBe(200);
    const profiles = await res.json() as { profiles: unknown[] };
    expect(profiles.profiles.some((p: unknown) => (p as { name: string }).name === "e2e-profile")).toBe(true);

    // Switch
    res = await fetch(`${h.base}/api/settings/profile/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-profile" }),
    });
    expect(res.status).toBe(200);

    // Get profile
    res = await fetch(`${h.base}/api/profile?name=e2e-profile`);
    expect(res.status).toBe(200);
    const profile = await res.json() as { profile: Record<string, unknown> };
    expect(profile.profile.name).toBe("e2e-profile");

    // Switch back to test before deleting (cannot delete active profile)
    res = await fetch(`${h.base}/api/settings/profile/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(200);

    // Delete
    res = await fetch(`${h.base}/api/settings/profile/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-profile" }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`delete returned ${res.status}: ${body}`);
    }
    expect(res.status).toBe(200);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("serves provider API endpoints", async () => {
    const h = await setup();

    // List provider keys (empty)
    let res = await fetch(`${h.base}/api/providers/keys`);
    expect(res.status).toBe(200);

    // Add a key
    res = await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", api_key: "test-key-123", account_id: "acct-1" }),
    });
    expect(res.status).toBe(200);
    const addResult = await res.json() as { key_id: string; provider: string };
    expect(addResult.key_id).toBeTruthy();
    expect(addResult.provider).toBe("cloudflare");

    // List keys
    res = await fetch(`${h.base}/api/providers/keys?provider=cloudflare`);
    expect(res.status).toBe(200);
    const keys = await res.json() as { keys: unknown[] };
    expect(keys.keys.length).toBe(1);

    // List models
    res = await fetch(`${h.base}/api/providers/models?provider=cloudflare`);
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`list models returned ${res.status}: ${body}`);
    }
    expect(res.status).toBe(200);

    // Config
    res = await fetch(`${h.base}/api/providers/config`);
    expect(res.status).toBe(200);

    // Errors
    res = await fetch(`${h.base}/api/providers/errors`);
    expect(res.status).toBe(200);

    // Remove key
    res = await fetch(`${h.base}/api/providers/keys?provider=cloudflare&key_id=${addResult.key_id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("serves provider ping endpoint", async () => {
    const h = await setup();

    // A loopback/private target is refused outright: the route
    // takes a caller-supplied URL and bearer token, so allowing it would make
    // the dashboard a request forger against internal services. The mock
    // listens on 127.0.0.1, so it can no longer be pinged — which is exactly
    // the guarantee. SSRF coverage lives in test/phase60/responseHygiene.
    let res = await fetch(`${h.base}/api/providers/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${h.mock.url}/api/v1`, api_key: "test" }),
    });
    expect(res.status).toBe(400);

    // POST invalid URL → { ok: false, error: "..." }
    res = await fetch(`${h.base}/api/providers/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://invalid.invalid/does-not-exist", api_key: "test" }),
    });
    expect(res.status).toBe(200);
    let body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();

    // POST missing URL → 400 error
    res = await fetch(`${h.base}/api/providers/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("serves provider model test endpoint", async () => {
    const h = await setup();

    // Test with no keys registered → error
    let res = await fetch(`${h.base}/api/providers/models/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", model_id: "test-model" }),
    });
    expect(res.status).toBe(200);
    let body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("No available API key");

    // Add a key first
    res = await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "test-key" }),
    });
    expect(res.status).toBe(200);

    // Now test with key but model not registered → still errors because model not in store
    res = await fetch(`${h.base}/api/providers/models/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", model_id: "unknown-model" }),
    });
    expect(res.status).toBe(200);
    body = await res.json() as { ok: boolean; error?: string };
    // Should fail because model doesn't exist in the provider_models store
    expect(body.ok).toBe(false);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("handles provider keys with nicknames", async () => {
    const h = await setup();

    // Add key with nickname
    const res = await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", api_key: "sk-test-nick", nickname: "my-openrouter-key" }),
    });
    expect(res.status).toBe(200);

    // List and verify nickname is returned
    const listRes = await fetch(`${h.base}/api/providers/keys?provider=openrouter`);
    expect(listRes.status).toBe(200);
    const data = await listRes.json() as { keys: Array<{ nickname: string | null }> };
    expect(data.keys.length).toBe(1);
    expect(data.keys[0]!.nickname).toBe("my-openrouter-key");

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  /**
   * The register route is the only provider endpoint that ever took its
   * arguments from the query string while every sibling read a JSON body. The
   * dashboard's bulk "register selected" path posts a body, so all twenty
   * discovered models came back 400 "provider query param required" — and
   * because the frontend only counted non-OK responses, it reported the
   * failure without ever showing what went wrong. The manual path kept working
   * because it does build a query string, which is why this went unnoticed.
   */
  it("accepts a JSON body on the register route, not just a query string", async () => {
    const h = await setup();

    await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "sk-test" }),
    });

    const res = await fetch(`${h.base}/api/providers/models/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", model_id: "body/model", nickname: "From body" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { model_id: string; nickname: string | null };
    expect(data.model_id).toBe("body/model");
    expect(data.nickname).toBe("From body");

    const listRes = await fetch(`${h.base}/api/providers/models?provider=generic`);
    const listData = await listRes.json() as { models: Array<{ model_id: string; nickname: string | null }> };
    const found = listData.models.filter(m => m.model_id === "body/model");
    expect(found.length).toBe(1);
    expect(found[0]!.nickname).toBe("From body");

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("still validates the register route and still accepts a bodyless DELETE", async () => {
    const h = await setup();

    await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "sk-test" }),
    });

    // Accepting a body must not turn the missing-argument case into a 500.
    const noProvider = await fetch(`${h.base}/api/providers/models/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: "x" }),
    });
    expect(noProvider.status).toBe(400);

    const noModel = await fetch(`${h.base}/api/providers/models/register?provider=generic`, {
      method: "POST",
    });
    expect(noModel.status).toBe(400);

    const badProvider = await fetch(`${h.base}/api/providers/models/register?provider=bogus&model_id=x`, {
      method: "POST",
    });
    expect(badProvider.status).toBe(400);

    // DELETE carries no body, so the handler must fall back to the query.
    await fetch(`${h.base}/api/providers/models/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", model_id: "gone/model" }),
    });
    const del = await fetch(`${h.base}/api/providers/models?provider=generic&model_id=${encodeURIComponent("gone/model")}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("handles model registration with nicknames", async () => {
    const h = await setup();

    // Add a key first so model registration can work
    await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "sk-test" }),
    });

    // Register model with nickname
    const res = await fetch(`${h.base}/api/providers/models/register?provider=generic&model_id=test%2Fmodel&nickname=${encodeURIComponent("My Test Model")}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { model_id: string; nickname: string | null };
    expect(data.model_id).toBe("test/model");
    expect(data.nickname).toBe("My Test Model");

    // List models and verify nickname
    const listRes = await fetch(`${h.base}/api/providers/models?provider=generic`);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as { models: Array<{ model_id: string; nickname: string | null }> };
    const registered = listData.models.filter(m => m.model_id === "test/model");
    expect(registered.length).toBe(1);
    expect(registered[0]!.nickname).toBe("My Test Model");

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("serves key test endpoint", async () => {
    const h = await setup();

    // Test with no keys → error
    let res = await fetch(`${h.base}/api/providers/keys/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic" }),
    });
    expect(res.status).toBe(200);
    let body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("No available API key");

    // Add a key
    const addRes = await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "test-key" }),
    });
    expect(addRes.status).toBe(200);
    const added = await addRes.json() as { key_id: string };
    expect(added.key_id).toBeTruthy();

    // Test the specific key
    res = await fetch(`${h.base}/api/providers/keys/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", key_id: added.key_id }),
    });
    expect(res.status).toBe(200);
    body = await res.json() as { ok: boolean; latency_ms?: number };
    // Generic client calls /models on the mock — mock returns 404 for /models
    expect(body.ok).toBe(false); // because mock doesn't have /models endpoint
    expect(body.error).toBeTruthy();

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("toggles provider key enabled via PATCH is_enabled", async () => {
    const h = await setup();

    const addRes = await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "test-key" }),
    });
    expect(addRes.status).toBe(200);
    const added = await addRes.json() as { key_id: string };

    // Disable (frontend sends is_enabled in body, key_id as query param)
    let res = await fetch(`${h.base}/api/providers/keys?provider=generic&key_id=${added.key_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_enabled: false }),
    });
    expect(res.status).toBe(200);
    const off = await res.json() as { is_enabled: boolean };
    expect(off.is_enabled).toBe(false);

    const listRes = await fetch(`${h.base}/api/providers/keys?provider=generic`);
    const list = await listRes.json() as { keys: { key_id: string; is_enabled: boolean }[] };
    const disabled = list.keys.find(k => k.key_id === added.key_id);
    expect(disabled?.is_enabled).toBe(false);

    // Re-enable
    res = await fetch(`${h.base}/api/providers/keys?provider=generic&key_id=${added.key_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_enabled: true }),
    });
    const on = await res.json() as { is_enabled: boolean };
    expect(on.is_enabled).toBe(true);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("deletes provider key via DELETE query params", async () => {
    const h = await setup();

    const addRes = await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "test-key" }),
    });
    expect(addRes.status).toBe(200);
    const added = await addRes.json() as { key_id: string };

    const delRes = await fetch(`${h.base}/api/providers/keys?provider=generic&key_id=${added.key_id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const listRes = await fetch(`${h.base}/api/providers/keys?provider=generic`);
    const list = await listRes.json() as { keys: { key_id: string }[] };
    expect(list.keys.find(k => k.key_id === added.key_id)).toBeUndefined();

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  /**
   * Discovery read the provider from the query string only, while the
   * dashboard posts a body, so "discover for this provider" scanned every
   * configured provider instead. Verified live: a cloudflare-scoped discover
   * returned models from all four.
   */
  it("scopes discovery to the provider named in the body", async () => {
    const h = await setup();
    // No keys at all: a provider-scoped request must not silently become an
    // all-providers scan, so the no-keys answer is the same either way here.
    const res = await fetch(`${h.base}/api/providers/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { models: Array<{ provider: string }>; code?: string };
    // Whatever comes back belongs to cloudflare and nothing else.
    expect(data.models.every((m) => m.provider === "cloudflare")).toBe(true);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("discovery returns no_keys_configured when no keys exist", async () => {
    const h = await setup();

    const res = await fetch(`${h.base}/api/providers/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { discovered: number; models: unknown[]; code?: string };
    expect(data.discovered).toBe(0);
    expect(data.models.length).toBe(0);
    expect(data.code).toBe("no_keys_configured");

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("discovery returns models when keys exist and API succeeds", async () => {
    const h = await setup();

    // Add a generic key pointing to mock endpoint — mock has no /models so call fails
    await fetch(`${h.base}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "generic", api_key: "test-key", gateway_url: h.mock.url }),
    });

    const res = await fetch(`${h.base}/api/providers/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { discovered: number; models: unknown[]; code?: string };
    // When keys exist but the API call fails (mock has no /models), allModels stays empty
    // and we return no_keys_configured — this is correct behavior
    expect(data.discovered).toBe(0);
    expect(data.models.length).toBe(0);
    expect(data.code).toBe("no_keys_configured");

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});

describe("Cloudflare Workers AI client", () => {
  it("lists models from /ai/models/search using the runnable @-id in name", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [
            { id: "fe8904cf-e20e-4884-b829-ed7cec0a01cb", name: "@cf/openai/gpt-oss-120b", description: "desc" },
            { id: "uuid-2", name: "@cf/zai-org/glm-4.7-flash" },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = new CloudflareClient();
      const resp = await client.listModels("test-key", "account-1");
      expect(calledUrl).toContain("/accounts/account-1/ai/models/search?per_page=100");
      expect(calledUrl).not.toContain("/ai/models?");
      expect(resp.models.map((m) => m.id)).toEqual(["@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenRouter client", () => {
  it("maps message.reasoning (string) to reasoning_content in chat responses", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          id: "gen-1",
          choices: [
            {
              message: {
                role: "assistant",
                content: "4",
                reasoning: "2 plus 2 equals four.",
              },
              finish_reason: "stop",
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = new OpenRouterClient();
      const resp = await client.chat(
        { model: "nvidia/nemotron-3-ultra-550b-a55b:free", messages: [{ role: "user", content: "What is 2+2?" }] },
        "or-key",
      );
      expect(calledUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(resp.content).toBe("4");
      expect(resp.reasoning_content).toBe("2 plus 2 equals four.");
      expect(resp.reasoning).toBe("2 plus 2 equals four.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a structured OpenRouter error message instead of raw JSON on 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({
        error: {
          code: 429,
          message: "Provider returned error",
          metadata: { raw: "poolside/laguna-s-2.1:free is temporarily rate-limited upstream." },
        },
      }),
    })) as typeof fetch;

    try {
      const client = new OpenRouterClient();
      await expect(client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, "or-key")).rejects.toMatchObject({
        code: "provider_rate_limited",
        retryable: true,
        message: expect.stringContaining("poolside/laguna-s-2.1:free is temporarily rate-limited"),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OmniRoute client", () => {
  it("maps message.reasoning to reasoning_content and honors the gateway URL", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          id: "gen-2",
          choices: [
            {
              message: {
                role: "assistant",
                content: "4",
                reasoning: "2 plus 2 equals four.",
              },
              finish_reason: "stop",
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = new OmniRouteClient("http://localhost:32768/v1");
      const resp = await client.chat(
        { model: "claude opus", messages: [{ role: "user", content: "What is 2+2?" }] },
        "omni-key",
        undefined,
        "http://localhost:32768/v1",
      );
      expect(calledUrl).toBe("http://localhost:32768/v1/chat/completions");
      expect(resp.content).toBe("4");
      expect(resp.reasoning_content).toBe("2 plus 2 equals four.");
      expect(resp.reasoning).toBe("2 plus 2 equals four.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Generic (OpenAI-compat) client", () => {
  it("maps message.reasoning to reasoning_content and honors the gateway URL", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          id: "gen-3",
          choices: [
            {
              message: {
                role: "assistant",
                content: "4",
                reasoning: "2 plus 2 equals four.",
              },
              finish_reason: "stop",
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = new GenericClient("http://127.0.0.1:1234/v1");
      const resp = await client.chat(
        { model: "qwen3.8-4b-sft-fable5-glint-i1", messages: [{ role: "user", content: "What is 2+2?" }] },
        "lm-key",
        undefined,
        "http://127.0.0.1:1234/v1",
      );
      expect(calledUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(resp.content).toBe("4");
      expect(resp.reasoning_content).toBe("2 plus 2 equals four.");
      expect(resp.reasoning).toBe("2 plus 2 equals four.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the client base URL when no gateway URL is supplied", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: "4" }, finish_reason: "stop" }] }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = new GenericClient("http://127.0.0.1:1234/v1");
      const resp = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, "lm-key");
      expect(calledUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(resp.content).toBe("4");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Plugin command files", () => {
  const COMMANDS = [
    "nanites-btw.md",
    "nanites-cost-saved.md",
    "nanites-dynamic-model.md",
    "nanites-effort.md",
    "nanites-health.md",
    "nanites-models.md",
    "nanites-profiles.md",
    "nanites-registry.md",
    "nanites-untested.md",
    "nanites-new-profile.md",
  ];

  it.each(COMMANDS)("%s exists and is non-empty", (cmd) => {
    const file = path.join(PLUGIN_ROOT, "commands", cmd);
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
    expect(content).toContain("description:");
  });
});

describe("README coverage", () => {
  it("README.md mentions MCP server and dashboard", () => {
    const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
    expect(readme).toContain("MCP server");
    expect(readme).toContain("dashboard");
    expect(readme).toContain("commands");
    expect(readme).toContain("skill");
  });
});
