import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearProfileBinding, setRouterHome } from "../../src/router/constants.js";

/** Fresh scratch directory under the OS temp dir, outside ~/.nanites. */
export function scratchHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nanites-p3-"));
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

/** Recursive file listing, for asserting what a store actually wrote. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/**
 * Write an active-profile pointer into a scratch home.
 *
 * The router resolves the ACTIVE profile (see src/router/constants.ts), so
 * every test that starts a router and seeds provider rows needs one. Without
 * it `routerProfile()` throws and the store call binds `undefined`, which
 * surfaces as the unhelpful "Provided value cannot be bound to SQLite
 * parameter 1" rather than as a missing profile.
 *
 * The pointer is a FILE, so it must exist on disk before the router resolves
 * the profile — writing it after `startRouter` is too late for any store call
 * made during boot.
 */
export function writeActiveProfile(home: string, name = "test-profile"): string {
  fs.writeFileSync(path.join(home, "active_profile.json"), JSON.stringify({ name }));
  // Two bindings, both needed. `setRouterHome` because a test that opens the DB
  // directly (no startRouter) would otherwise resolve the AMBIENT home and
  // read a different profile's keys -- which looks exactly like "no keys
  // configured". `clearProfileBinding` because the cache is per home and a
  // test switching homes must not be served the previous one's profile.
  setRouterHome(home);
  clearProfileBinding();
  return name;
}

/** The profile name a scratch-home router will resolve. */
export const TEST_PROFILE = "test-profile";
