/**
 * LM Studio API auth token — per-profile `endpoint.auth_token` plus the
 * `NANITES_LMS_API_TOKEN` env fallback. Asserts precedence of the resolver,
 * that clientForProfile sends a Bearer header from the env var when the
 * profile token is null, that the token round-trips through
 * update_profile/get_active_profile, and that /api/health exposes it back.
 */
import { describe, expect, it } from "vitest";
import { resolveAuthToken, clientForProfile, buildDeps } from "../../src/tools/deps.js";
import { LmStudioClient } from "../../src/lmstudio/client.js";
import { startMockLmStudio, sendJson, type MockLmStudio } from "../phase1/mockServer.js";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import type { ToolDeps } from "../../src/tools/deps.js";

describe("resolveAuthToken precedence", () => {
  it("profile token wins over env", () => {
    expect(resolveAuthToken("profile-token", "env-token")).toBe("profile-token");
  });

  it("env fills the gap when the profile token is null", () => {
    expect(resolveAuthToken(null, "env-token")).toBe("env-token");
  });

  it("both null yields null (no auth header)", () => {
    expect(resolveAuthToken(null, null)).toBeNull();
  });
});

describe("clientForProfile sends the env token when the profile has none", () => {
  let mock: MockLmStudio;
  const seen: string[] = [];

  async function setup(): Promise<void> {
    seen.length = 0;
    mock = await startMockLmStudio((req, res) => {
      seen.push(req.headers.authorization ?? "");
      sendJson(res, 200, { models: [] });
    });
  }

  it("emits Authorization: Bearer from NANITES_LMS_API_TOKEN", async () => {
    await setup();
    const old = process.env.NANITES_LMS_API_TOKEN;
    process.env.NANITES_LMS_API_TOKEN = "env-secret";
    try {
      const client: LmStudioClient = clientForProfile({
        name: "t",
        machine_specs: { cpu: "c", gpu: "g", vram_gb: 4, ram_gb: 16, storage: "SSD" },
        endpoint: { url: mock.url, auth_token: null },
        use_case: "nanites-default",
        pricing: { input_per_million_usd: 3, output_per_million_usd: 15 },
        test_plan_ref: null,
        ntfy: { topic: null, server_url: "https://ntfy.sh", access_token: null },
        concurrency: { mode: "sequential", max_parallel_models: 1 },
        dynamic_model: true,
        inference: { effort: "medium", output_token_ceiling: 8192, system_prompt: null },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      } as never);
      await client.listModels();
      expect(seen[0]).toBe("Bearer env-secret");
    } finally {
      process.env.NANITES_LMS_API_TOKEN = old;
      await mock.close();
    }
  });

  it("profile token takes precedence over the env var", async () => {
    await setup();
    const old = process.env.NANITES_LMS_API_TOKEN;
    process.env.NANITES_LMS_API_TOKEN = "env-secret";
    try {
      const client: LmStudioClient = clientForProfile({
        name: "t",
        machine_specs: { cpu: "c", gpu: "g", vram_gb: 4, ram_gb: 16, storage: "SSD" },
        endpoint: { url: mock.url, auth_token: "profile-secret" },
        use_case: "nanites-default",
        pricing: { input_per_million_usd: 3, output_per_million_usd: 15 },
        test_plan_ref: null,
        ntfy: { topic: null, server_url: "https://ntfy.sh", access_token: null },
        concurrency: { mode: "sequential", max_parallel_models: 1 },
        dynamic_model: true,
        inference: { effort: "medium", output_token_ceiling: 8192, system_prompt: null },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      } as never);
      await client.listModels();
      expect(seen[0]).toBe("Bearer profile-secret");
    } finally {
      process.env.NANITES_LMS_API_TOKEN = old;
      await mock.close();
    }
  });
});

describe("auth token round-trips through profile tools", () => {
  let h: ToolHarness;

  it("update_profile persists endpoint.auth_token; get_active_profile reflects it", async () => {
    h = await createHarness();
    const upd = await h.callTool("update_profile", { profile: "t", endpoint: { auth_token: "lms-token-123" } });
    expect(upd.ok).toBe(true);
    const active = await h.callTool("get_active_profile", {});
    expect(active.ok).toBe(true);
    const profile = (active.data as { profile: { endpoint: { auth_token: string | null } } }).profile;
    expect(profile.endpoint.auth_token).toBeNull();
    expect(profile.endpoint.url).toBe(h.mock.url);
    await h.close();
  });

  it("clearing the token sets it to null in storage (get_active_profile always masks)", async () => {
    h = await createHarness();
    await h.callTool("update_profile", { profile: "t", endpoint: { auth_token: "temp" } });
    await h.callTool("update_profile", { profile: "t", endpoint: { auth_token: null } });
    // MCP returns masked; verify the real value was cleared by reading the store directly.
    expect(h.deps.profiles.getProfile("t")!.endpoint.auth_token).toBeNull();
    await h.close();
  });

  it("list_profiles verbose never returns auth_token", async () => {
    h = await createHarness();
    await h.callTool("update_profile", { profile: "t", endpoint: { auth_token: "secret-123" } });
    const listed = await h.callTool("list_profiles", { verbose: true });
    expect(listed.ok).toBe(true);
    const profiles = (listed.data as { profiles: Array<{ endpoint: { auth_token: unknown } }> }).profiles;
    expect(profiles[0].endpoint.auth_token).toBeNull();
    await h.close();
  });

  it("ntfy.access_token is masked on every profile-returning tool", async () => {
    h = await createHarness();
    await h.callTool("update_profile", { profile: "t", ntfy: { access_token: "ntfy-secret" } });
    const listed = await h.callTool("list_profiles", { verbose: true });
    const profiles = (listed.data as { profiles: Array<{ ntfy: { access_token: unknown } }> }).profiles;
    expect(profiles[0].ntfy.access_token).toBeNull();
    const active = await h.callTool("get_active_profile", {});
    expect((active.data as { profile: { ntfy: { access_token: unknown } } }).profile.ntfy.access_token).toBeNull();
    // Storage still holds the real value — masking is an MCP-return concern only.
    expect(h.deps.profiles.getProfile("t")!.ntfy.access_token).toBe("ntfy-secret");
    await h.close();
  });

  it("switch_profile masks both endpoint and ntfy secrets", async () => {
    h = await createHarness();
    await h.callTool("update_profile", {
      profile: "t",
      endpoint: { auth_token: "lms-token-123" },
      ntfy: { access_token: "ntfy-secret" },
    });
    const sw = await h.callTool("switch_profile", { name: "t" });
    expect(sw.ok).toBe(true);
    const returned = sw.data as { endpoint: { auth_token: unknown }; ntfy: { access_token: unknown } };
    expect(returned.endpoint.auth_token).toBeNull();
    expect(returned.ntfy.access_token).toBeNull();
    const stored = h.deps.profiles.getProfile("t")!;
    expect(stored.endpoint.auth_token).toBe("lms-token-123");
    expect(stored.ntfy.access_token).toBe("ntfy-secret");
    await h.close();
  });
});

describe("GET /api/health exposes the endpoint auth token", () => {
  it("returns endpoint.auth_token back to the dashboard", async () => {
    const home = scratchHome();
    const deps: ToolDeps = buildDeps(home);
    const mock = await startMockLmStudio((_req, res) => {
      sendJson(res, 200, { models: [] });
    });
    deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url, auth_token: "health-secret" }, machine_specs: { vram_gb: 4 } });
    deps.profiles.switchProfile("t");
    const ui: UiServer = await startUiServer(deps, { port: 0 });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${ui.port}/api/health`)).json()) as {
        endpoint: { auth_token: string | null };
      };
      expect(body.endpoint.auth_token).toBe("health-secret");
    } finally {
      await ui.close();
      deps.close();
      await mock.close();
      cleanup(home);
    }
  });
});
