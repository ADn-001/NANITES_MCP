import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNanitesHome, nanitesLayout } from "../../src/config/paths.js";
import { openNanitesDb } from "../../src/storage/db.js";
import { RegistryStore } from "../../src/storage/registryStore.js";
import { ProfileManager } from "../../src/storage/profileManager.js";
import { cleanup, scratchHome, filesUnder } from "./helpers.js";

const homes: string[] = [];
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-fake-home-"));

// Isolate "the real home" from an actually-used ~/.nanites (a live profile may
// already be registered there) so the leak assertions stay meaningful.
beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("storage location — NANITES_HOME governs everything", () => {
  const scratch = scratchHome();
  homes.push(scratch);

  it("resolveNanitesHome honors the env override", () => {
    expect(resolveNanitesHome({ NANITES_HOME: scratch })).toBe(path.resolve(scratch));
    expect(resolveNanitesHome({})).toBe(path.join(os.homedir(), ".nanites"));
  });

  it("profiles and the SQLite DB are created under NANITES_HOME, never ~/.nanites", () => {
    const realHome = path.join(os.homedir(), ".nanites");

    const pm = new ProfileManager(scratch);
    pm.createProfile({ name: "loc" });
    pm.switchProfile("loc");

    const { db, close } = openNanitesDb(scratch);
    new RegistryStore(db).upsert("loc", { model_id: "m", roles: [], scores: {}, best_params: {}, last_tested: null });
    close();

    const written = filesUnder(scratch);
    expect(written).toContain(path.join(scratch, "profiles", "loc.json"));
    expect(written).toContain(path.join(scratch, "active_profile.json"));
    expect(written).toContain(path.join(scratch, "nanites.db"));

    // Nothing Nanites writes leaks under the real home when the env var is set.
    expect(fs.existsSync(path.join(realHome, "nanites.db"))).toBe(false);
    expect(fs.existsSync(path.join(realHome, "active_profile.json"))).toBe(false);
    expect(fs.existsSync(path.join(realHome, "profiles", "loc.json"))).toBe(false);
  });

  it("nanitesLayout points at the env override too", () => {
    const layout = nanitesLayout(scratch);
    expect(layout.dbPath).toBe(path.join(scratch, "nanites.db"));
    expect(layout.profilesDir).toBe(path.join(scratch, "profiles"));
  });

  afterAll(() => {
    cleanup(scratch);
  });
});

afterAll(() => {
  for (const h of homes) cleanup(h);
});
