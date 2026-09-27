/**
 * Phase 35 — dashboard/LMS lifecycle (`src/ui/lifecycle.ts`). Asserted without
 * real child processes: identity gate (foreign listeners never killed), the
 * AUTOSTART_UI=0 opt-out, reachable-short-circuit, and the non-blocking boot
 * sequence. Spawn / netstat / taskkill paths are exercised live only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDashboardStarted, killStaleDashboard, lifecycleBoot } from "../../src/ui/lifecycle.js";

const keep = {
  auto: process.env.NANITES_AUTOSTART_UI,
  port: process.env.NANITES_UI_PORT,
};

afterEach(() => {
  if (keep.auto === undefined) delete process.env.NANITES_AUTOSTART_UI;
  else process.env.NANITES_AUTOSTART_UI = keep.auto;
  if (keep.port === undefined) delete process.env.NANITES_UI_PORT;
  else process.env.NANITES_UI_PORT = keep.port;
  vi.restoreAllMocks();
});

describe("ensureDashboardStarted", () => {
  it("reports disabled when autostart is off (no decoration allowed)", async () => {
    process.env.NANITES_AUTOSTART_UI = "0";
    process.env.NANITES_UI_PORT = "4700";
    const handle = await ensureDashboardStarted();
    expect(handle.started).toBe(false);
    expect(handle.enabled).toBe(false);
    expect(handle.url).toBe("http://127.0.0.1:4700");
  });

  it("reuses an already-reachable dashboard", async () => {
    delete process.env.NANITES_AUTOSTART_UI;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    const handle = await ensureDashboardStarted();
    expect(handle.started).toBe(true);
    expect(handle.enabled).toBe(true);
  });

  it("never spawns: not-serving still enables decoration so the host can start it by opening the deep link", async () => {
    delete process.env.NANITES_AUTOSTART_UI;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
    const handle = await ensureDashboardStarted();
    expect(handle.started).toBe(false);
    expect(handle.enabled).toBe(true);
    expect(handle.url).toBe("http://127.0.0.1:4700");
  });
});

describe("killStaleDashboard", () => {
  it("no-ops when autostart is disabled", async () => {
    process.env.NANITES_AUTOSTART_UI = "0";
    await expect(killStaleDashboard()).resolves.toBeUndefined();
  });

  it("never kills a foreign listener on the port", async () => {
    delete process.env.NANITES_AUTOSTART_UI;
    // Not our dashboard: /api/profiles does not answer with { profiles, active }.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
    await expect(killStaleDashboard(4700)).resolves.toBeUndefined();
  });
});

describe("lifecycleBoot", () => {
  it("runs the kill step without throwing when autostart is on", async () => {
    delete process.env.NANITES_AUTOSTART_UI;
    // Reachable probe only — no dashboard on the test port either way.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
    await expect(lifecycleBoot()).resolves.toBeUndefined();
  });
});
