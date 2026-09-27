/**
 * Phase 15 gate — POST /api/settings/profile. A valid partial patch persists
 * and reloads (including the theme field); an invalid patch returns a
 * structured error and leaves the stored profile unchanged (no partial write).
 */
import { describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function setup(): Promise<{ deps: ToolDeps; ui: UiServer; base: string }> {
  const home = scratchHome();
  const deps = buildDeps(home);
  deps.profiles.createProfile({ name: "t", machine_specs: { vram_gb: 4 } });
  deps.profiles.switchProfile("t");
  const ui = await startUiServer(deps, { port: 0 });
  return { deps, ui, base: `http://127.0.0.1:${ui.port}` };
}

describe("POST /api/settings/profile", () => {
  it("persists a valid partial patch and reloads it", async () => {
    const { deps, ui, base } = await setup();

    const { status, json } = await post(base, "/api/settings/profile", {
      machine_specs: { vram_gb: 16 },
      theme: "claude",
    });
    expect(status).toBe(200);
    expect((json as { profile: { theme: string } }).profile.theme).toBe("claude");

    const active = deps.profiles.getActiveProfile()!;
    expect(active.machine_specs.vram_gb).toBe(16);
    expect(active.theme).toBe("claude");
    // vram_gb 16 falls in the 12-24GB (high) tier -> parallel mode, default pair 2x2.
    expect(active.concurrency.mode).toBe("parallel");
    expect(active.concurrency.max_parallel_models).toBe(2);
    expect(active.concurrency.num_parallel).toBe(2);

    await ui.close();
    deps.close();
    cleanup(deps.home);
  });

  it("rejects an invalid patch and leaves the file unchanged", async () => {
    const { deps, ui, base } = await setup();

    // First a valid patch so there is a known-good baseline. "anthropic" is a
    // name an earlier build wrote to disk; it must still be accepted and
    // normalized forward rather than rejected by the schema.
    await post(base, "/api/settings/profile", { machine_specs: { vram_gb: 16 }, theme: "anthropic" });

    const { status, json } = await post(base, "/api/settings/profile", { machine_specs: { vram_gb: "big" } });
    expect(status).toBe(400);
    expect(json).toEqual({ code: "bad_request", message: expect.any(String), retryable: false });

    // No partial write: baseline values survive.
    const active = deps.profiles.getActiveProfile()!;
    expect(active.machine_specs.vram_gb).toBe(16);
    expect(active.theme).toBe("claude");

    await ui.close();
    deps.close();
    cleanup(deps.home);
  });

  it("returns a structured error for a non-object body", async () => {
    const { deps, ui, base } = await setup();

    const { status, json } = await post(base, "/api/settings/profile", "garbage");
    expect(status).toBe(400);
    expect(json).toEqual({ code: "bad_request", message: expect.any(String), retryable: false });

    await ui.close();
    deps.close();
    cleanup(deps.home);
  });
});
