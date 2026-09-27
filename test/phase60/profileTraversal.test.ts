/**
 * Phase 60 gate — profile-delete path traversal.
 *
 * `deleteProfile` had no name validation while `getProfile` and
 * `createProfile` did, and its name went through `path.join`, which
 * normalizes `..` away. `PROFILE_NAME_RE` alone was not enough: it accepts
 * "." and "..", so `../active_profile` resolved to `<home>/active_profile.json`
 * — the real active-profile pointer, one level above the profiles dir.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileManager } from "../../src/storage/profileManager.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

describe("deleteProfile refuses a traversal name", () => {
  it.each(["..", ".", "../active_profile", "../../x", "a/b", "a\b"])(
    "rejects %j without touching the filesystem",
    (name) => {
      const home = scratchHome();
      const pm = new ProfileManager(home);
      // Plant a real file at the traversal target. Without it, deleteProfile
      // throws profile_not_found and the case would pass for the wrong reason.
      fs.writeFileSync(path.join(home, "active_profile.json"), JSON.stringify({ name: "keep" }));
      fs.writeFileSync(path.join(home, "x.json"), "{}");
      const profilesDir = path.join(home, "profiles");
      const pointer = path.join(home, "active_profile.json");
      const before = fs.readdirSync(profilesDir);
      const pointerBefore = fs.existsSync(pointer);

      expect(() => pm.deleteProfile(name)).toThrowError();

      // Nothing was removed: neither a profile, the pointer, nor the decoy.
      expect(fs.readdirSync(profilesDir)).toEqual(before);
      expect(fs.existsSync(pointer)).toBe(pointerBefore);
      expect(fs.existsSync(path.join(home, "x.json"))).toBe(true);
      cleanup(home);
    },
  );

  it("leaves the active-profile pointer intact for the real attack name", () => {
    const home = scratchHome();
    const pm = new ProfileManager(home);
    pm.createProfile({ name: "keep", machine_specs: { vram_gb: 4 } });
    pm.switchProfile("keep");
    const pointer = path.join(home, "active_profile.json");
    expect(fs.existsSync(pointer)).toBe(true);

    expect(() => pm.deleteProfile("../active_profile")).toThrowError();

    expect(fs.existsSync(pointer)).toBe(true);
    expect(pm.getActiveProfile()?.name).toBe("keep");
    cleanup(home);
  });

  it("still deletes a legitimate profile", () => {
    const home = scratchHome();
    const pm = new ProfileManager(home);
    pm.createProfile({ name: "gone", machine_specs: { vram_gb: 4 } });
    expect(fs.existsSync(path.join(home, "profiles", "gone.json"))).toBe(true);
    pm.deleteProfile("gone");
    expect(fs.existsSync(path.join(home, "profiles", "gone.json"))).toBe(false);
    cleanup(home);
  });
});
