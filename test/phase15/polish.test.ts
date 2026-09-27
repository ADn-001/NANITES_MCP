/**
 * Polish-sprint gate — new UI routes + global Broadcast setting.
 * Covers: extended /api/profiles (effort + concurrency tier), profile
 * switch/create/delete routes (with active/last guards), and the broadcast
 * helpers + /api/settings/dashboard.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import {
  readDashboardSettings,
  writeDashboardSettings,
  lanIPv4,
  findFreePort,
  projectBroadcast,
} from "../../src/ui/broadcast.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

async function get(base: string, p: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, json: await res.json() };
}
async function post(base: string, p: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${p}`, {
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

type ProfileListItem = {
  name: string;
  effort: string;
  concurrency_tier: string;
  mode: string;
};

describe("/api/profiles + profile lifecycle routes", () => {
  it("GET /api/profile returns the full token over loopback (local editor)", async () => {
    const { deps, ui, base } = await setup();
    deps.profiles.updateProfile("t", { endpoint: { auth_token: "sk-lm-loopback-secret" } });
    const { status, json } = await get(base, "/api/profile?name=t");
    expect(status).toBe(200);
    const prof = (json as { profile: { endpoint: { auth_token: string | null } } }).profile;
    // The masking branch is only for non-loopback (LAN) peers; a loopback
    // request must keep the real token so the local editor round-trips.
    expect(prof.endpoint.auth_token).toBe("sk-lm-loopback-secret");
    await ui.close();
    deps.close();
    cleanup(deps.home);
  });
  it("GET /api/profiles includes effort and concurrency tier", async () => {
    const { deps, ui, base } = await setup();
    const { status, json } = await get(base, "/api/profiles");
    expect(status).toBe(200);
    const list = (json as { profiles: ProfileListItem[] }).profiles;
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ name: "t", effort: "medium" });
    expect(list[0].concurrency_tier).toBeTruthy();
    expect(list[0].mode).toBe("sequential"); // vram 4 < 6GB
    await ui.close();
    deps.close();
    cleanup(deps.home);
  });

  it("POST /api/settings/profile/switch makes a profile active", async () => {
    const { deps, ui, base } = await setup();
    deps.profiles.createProfile({ name: "u" });
    const { status, json } = await post(base, "/api/settings/profile/switch", { name: "u" });
    expect(status).toBe(200);
    expect((json as { active: string }).active).toBe("u");
    expect(deps.profiles.getActiveProfile()!.name).toBe("u");
    await ui.close();
    deps.close();
    cleanup(deps.home);
  });

  it("POST /api/settings/profile/create persists endpoint.url default", async () => {
    const { deps, ui, base } = await setup();
    const { status } = await post(base, "/api/settings/profile/create", { name: "b" });
    expect(status).toBe(200);
    expect(deps.profiles.getProfile("b")!.endpoint.url).toBe("http://localhost:1234");

    await post(base, "/api/settings/profile/create", { name: "c", endpoint_url: "http://10.0.0.5:4321" });
    expect(deps.profiles.getProfile("c")!.endpoint.url).toBe("http://10.0.0.5:4321");
    await ui.close();
    deps.close();
    cleanup(deps.home);
  });

  it("POST /api/settings/profile/delete refuses the active profile", async () => {
    const { deps, ui, base } = await setup();
    deps.profiles.createProfile({ name: "u" }); // active is still "t"
    const { status, json } = await post(base, "/api/settings/profile/delete", { name: "t" });
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("profile_active");
    await ui.close();
    deps.close();
    cleanup(deps.home);
  });

  it("POST /api/settings/profile/delete deletes a non-active profile", async () => {
    const { deps, ui, base } = await setup();
    deps.profiles.createProfile({ name: "u" });
    const { status, json } = await post(base, "/api/settings/profile/delete", { name: "u" });
    expect(status).toBe(200);
    expect((json as { active: string }).active).toBe("t");
    expect(deps.profiles.listProfiles()).toEqual(["t"]);
    await ui.close();
    deps.close();
    cleanup(deps.home);
  });

  it("POST /api/settings/profile/delete refuses the last profile (409)", async () => {
    const { deps, ui, base } = await setup();
    // Corrupt the active pointer so activeProfileName is null while one profile
    // remains on disk -> the active guard passes, the last-profile guard fires.
    fs.writeFileSync(path.join(deps.home, "active_profile.json"), JSON.stringify({ profile: "ghost" }));
    const { status, json } = await post(base, "/api/settings/profile/delete", { name: "t" });
    expect(status).toBe(409);
    expect((json as { code: string }).code).toBe("last_profile");
    await ui.close();
    deps.close();
    cleanup(deps.home);
  });
});

describe("Broadcast (global dashboard setting)", () => {
  it("read/write round-trips the boolean", () => {
    const home = scratchHome();
    writeDashboardSettings(home, { broadcast: true });
    expect(readDashboardSettings(home).broadcast).toBe(true);
    writeDashboardSettings(home, { broadcast: false });
    expect(readDashboardSettings(home).broadcast).toBe(false);
    cleanup(home);
  });

  it("lanIPv4 returns a plausible LAN string or null", async () => {
    const ip = await lanIPv4();
    expect(ip === null || typeof ip === "string").toBe(true);
  });

  it("findFreePort returns a bindable positive port", async () => {
    const port = await findFreePort(0);
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  it("projectBroadcast reports the LAN URL when enabled", async () => {
    const home = scratchHome();
    writeDashboardSettings(home, { broadcast: true });
    const proj = await projectBroadcast(home, 0);
    expect(proj.enabled).toBe(true);
    expect(proj.host).toBe("0.0.0.0");
    expect(proj.port).toBeGreaterThan(0);
    expect(proj.url === null || proj.url!.startsWith("http://")).toBe(true);
    cleanup(home);
  });

  it("projectBroadcast is localhost when disabled", async () => {
    const home = scratchHome();
    const proj = await projectBroadcast(home, 4700);
    expect(proj.enabled).toBe(false);
    expect(proj.host).toBe("127.0.0.1");
    expect(proj.url).toBeNull();
    cleanup(home);
  });

  it("startUiServer binds 0.0.0.0 when broadcast is on", async () => {
    const home = scratchHome();
    writeDashboardSettings(home, { broadcast: true });
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");
    const ui = await startUiServer(deps, { port: 0 });
    const addr = ui.server.address();
    expect(addr && typeof addr === "object" ? addr.address : "127.0.0.1").toBe("0.0.0.0");
    await ui.close();
    deps.close();
    cleanup(home);
  });

  it("POST /api/settings/dashboard applies broadcast live (rebinds listener)", async () => {
    const { deps, ui } = await setup();

    const addr0 = ui.server.address();
    expect(addr0 && typeof addr0 === "object" ? addr0.address : "127.0.0.1").toBe("127.0.0.1");

    // Enable: the running listener must rebind to 0.0.0.0, no restart needed.
    const r1 = await post(`http://127.0.0.1:${ui.port}`, "/api/settings/dashboard", { broadcast: true });
    expect(r1.status).toBe(200);
    const j1 = r1.json as { broadcast: { enabled: boolean; url: string | null }; applies: string; redirectTo: string };
    expect(j1.applies).toBe("now");
    expect(j1.broadcast.enabled).toBe(true);
    expect(j1.broadcast.url === null || j1.broadcast.url!.startsWith("http://")).toBe(true);
    expect(typeof j1.redirectTo).toBe("string");
    expect(readDashboardSettings(deps.home).broadcast).toBe(true);

    const a1 = ui.server.address();
    const host1 = a1 && typeof a1 === "object" ? a1.address : "127.0.0.1";
    const port1 = a1 && typeof a1 === "object" ? a1.port : ui.port;
    expect(host1).toBe("0.0.0.0");
    // 0.0.0.0 is reachable via loopback; GET reflects the live bind.
    const g1 = (await get(`http://127.0.0.1:${port1}`, "/api/settings/dashboard")).json as {
      broadcast: { enabled: boolean };
    };
    expect(g1.broadcast.enabled).toBe(true);

    // Disable: rebind back to 127.0.0.1.
    const r2 = await post(`http://127.0.0.1:${port1}`, "/api/settings/dashboard", { broadcast: false });
    const j2 = r2.json as { broadcast: { enabled: boolean }; applies: string };
    expect(r2.status).toBe(200);
    expect(j2.applies).toBe("now");
    expect(j2.broadcast.enabled).toBe(false);
    const a2 = ui.server.address();
    expect(a2 && typeof a2 === "object" ? a2.address : "127.0.0.1").toBe("127.0.0.1");
    expect(readDashboardSettings(deps.home).broadcast).toBe(false);

    await ui.close();
    deps.close();
    cleanup(deps.home);
  });
});
