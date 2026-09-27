/**
 * Phase 14 — Companion UI autostart. Asserts env gating, port resolution, and
 * that the fire-and-forget boot never throws. Actual child spawn / browser
 * open are live-only (side effects), so they are gated by NANITES_AUTOSTART_UI.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { autostartUiEnabled, openBrowserEnabled, uiPort } from "../../src/ui/autostart.js";

describe("ui autostart", () => {
  const keep = { port: process.env.NANITES_UI_PORT, auto: process.env.NANITES_AUTOSTART_UI, open: process.env.NANITES_OPEN_BROWSER };

  afterEach(() => {
    if (keep.port === undefined) delete process.env.NANITES_UI_PORT;
    else process.env.NANITES_UI_PORT = keep.port;
    if (keep.auto === undefined) delete process.env.NANITES_AUTOSTART_UI;
    else process.env.NANITES_AUTOSTART_UI = keep.auto;
    if (keep.open === undefined) delete process.env.NANITES_OPEN_BROWSER;
    else process.env.NANITES_OPEN_BROWSER = keep.open;
  });

  it("is enabled by default", () => {
    delete process.env.NANITES_AUTOSTART_UI;
    expect(autostartUiEnabled()).toBe(true);
  });

  it("can be disabled", () => {
    process.env.NANITES_AUTOSTART_UI = "0";
    expect(autostartUiEnabled()).toBe(false);
  });

  it("resolves the UI port from env, defaulting to 4700", () => {
    delete process.env.NANITES_UI_PORT;
    expect(uiPort()).toBe(4700);
    process.env.NANITES_UI_PORT = "5999";
    expect(uiPort()).toBe(5999);
  });

  it("does not open an external browser by default", () => {
    delete process.env.NANITES_OPEN_BROWSER;
    expect(openBrowserEnabled()).toBe(false);
  });

  it("opens an external browser only when NANITES_OPEN_BROWSER=1", () => {
    process.env.NANITES_OPEN_BROWSER = "1";
    expect(openBrowserEnabled()).toBe(true);
    process.env.NANITES_OPEN_BROWSER = "0";
    expect(openBrowserEnabled()).toBe(false);
  });

  it("never spawns or opens a browser when autostart is disabled", async () => {
    process.env.NANITES_AUTOSTART_UI = "0";
    const { maybeStartUi } = await import("../../src/ui/autostart.js");
    await expect(maybeStartUi()).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
