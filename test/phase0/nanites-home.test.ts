import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NANITES_HOME_ENV, ensureNanitesHome, nanitesLayout, resolveNanitesHome } from "../../src/config/paths.js";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-home-test-"));
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-fake-home-"));

// Isolate "the real home" from an actually-used ~/.nanites so the "never leak
// to the real home" assertions stay meaningful on a dev machine with a live
// profile already registered.
beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
});
afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("NANITES_HOME resolution", () => {
  it("defaults to ~/.nanites when the env var is unset", () => {
    const env: NodeJS.ProcessEnv = {};
    const expected = path.join(os.homedir(), ".nanites");
    expect(resolveNanitesHome(env)).toBe(expected);
  });

  it("honors an explicit NANITES_HOME", () => {
    const env: NodeJS.ProcessEnv = { [NANITES_HOME_ENV]: SCRATCH };
    expect(resolveNanitesHome(env)).toBe(path.resolve(SCRATCH));
  });
});

describe("ensureNanitesHome layout", () => {
  beforeAll(() => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("creates the directory structure under NANITES_HOME, not under the real home", () => {
    const layout = ensureNanitesHome(SCRATCH);

    expect(layout.profilesDir).toBe(path.join(SCRATCH, "profiles"));
    expect(layout.logsDir).toBe(path.join(SCRATCH, "logs"));
    expect(layout.dbPath).toBe(path.join(SCRATCH, "nanites.db"));

    expect(fs.existsSync(layout.profilesDir)).toBe(true);
    expect(fs.existsSync(layout.logsDir)).toBe(true);

    // Nothing may be written to the default ~/.nanites location.
    const realHome = os.homedir();
    expect(layout.home).not.toBe(path.join(realHome, ".nanites"));
    expect(fs.existsSync(path.join(realHome, ".nanites"))).toBe(false);
  });

  it("is idempotent across repeated calls", () => {
    const first = ensureNanitesHome(SCRATCH);
    const second = ensureNanitesHome(SCRATCH);
    expect(second).toEqual(first);
  });

  it("nanitesLayout is pure — no side effects", () => {
    const layout = nanitesLayout(path.join(SCRATCH, "never-created"));
    expect(fs.existsSync(layout.home)).toBe(false);
  });
});
