/**
 * Which profile's provider rows the router reads and writes.
 *
 * ## What changed, and why
 *
 * This used to be a hardcoded `ROUTER_PROFILE = "__router__"`. The intent,
 * stated in `src/router/main.ts` and in the migration comment, was that the
 * router "reuses the provider key store rather than asking the user to
 * re-enter every provider key in a second place".
 *
 * The code did not do that. It reused the TABLE and not the ROWS, and because
 * nothing in the product ever wrote a key under `__router__`, the router was
 * reading an empty set. Verified against the real database: the only INSERT
 * into `provider_api_keys` in the tree is in `providerKeyStore.ts`, and every
 * caller passes an active profile name. The result was a gateway that resolved
 * no providers at all, and a "Providers" panel in the router tab that showed
 * nothing because there was nothing to show.
 *
 * So the constant is gone and the router now reads the ACTIVE profile — the
 * same rows the Providers tab writes. One set of keys, configured in one place.
 *
 * ## The decision this gives up
 *
 * "Router config is global" (docs/router/02-SPEC.md) is intentionally no
 * longer true for PROVIDER KEYS. A gateway serving remote harnesses now
 * inherits whichever local profile happens to be active, and switching
 * profiles changes the keys the router uses. That is a real trade: it couples
 * the gateway to local state.
 *
 * It is the right trade here, because the alternative was a namespace nothing
 * could write to, and a shared key store the user had to populate twice. The
 * remaining router state — config, key metrics, aliases, the advertised
 * catalog, jobs, sticky — stays global, because none of it is reachable from
 * the Providers tab anyway.
 *
 * ## Resolution
 *
 * Resolved ONCE per home and cached, because these are synchronous store calls
 * on the request path and re-reading a file per provider lookup would be both
 * slower and easy to get wrong. `clearProfileBinding` exists for tests and for
 * a profile switch.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NanitesError } from "../helpers/errors.js";

/** The legacy namespace, kept only so its rows can be migrated, not used. */
export const LEGACY_ROUTER_PROFILE = "__router__";

/**
 * Still reserved. A profile may not be NAMED this, because the legacy rows
 * live under it and a new profile with that name would collide with them
 * during migration.
 */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([LEGACY_ROUTER_PROFILE]);

let cached: { home: string; profile: string; mtimeMs: number } | null = null;

/**
 * The home the running router opened, set once at boot.
 *
 * Set by `startRouter` rather than read from the environment, because the two
 * can differ: an explicit `home` option wins over NANITES_HOME, and every
 * store call the router makes must resolve against the database that router is
 * actually attached to.
 */
let boundHome: string | null = null;

export function setRouterHome(home: string): void {
  boundHome = home;
  // A different home is a different profile; the cache must not cross over.
  cached = null;
}

export function routerHome(): string | null {
  return boundHome;
}

/**
 * The active profile name, for every profile-scoped store call the router makes.
 *
 * Throws rather than returning a default when there is no active profile: a
 * gateway with no keys should say so at the point of use, because silently
 * substituting a name would send a request to a provider the operator never
 * configured.
 */
export function routerProfile(home?: string): string {
  // `setRouterHome` records the home the router actually opened, which is the
  // ONLY correct answer. Falling back to the ambient NANITES_HOME looks
  // equivalent and is not: `startRouter({home})` accepts an explicit home, so
  // a caller (and every test) can boot a router against a directory that has
  // nothing to do with the environment variable. Reading the env then resolves
  // the WRONG profile, and the symptom is a 402 "no enabled, un-exhausted
  // key" against a key the test just wrote three lines earlier.
  const resolvedHome = home ?? routerHome() ?? process.env["NANITES_HOME"] ?? defaultHome();

  // Cached against the active-profile file's mtime, not forever.
  //
  // The cache exists because these are synchronous store calls on the request
  // path. It is invalidated by mtime rather than never, because the whole
  // point of the router reading the ACTIVE profile is that a key added in the
  // Providers tab is usable by the gateway IMMEDIATELY -- a cache that only a
  // restart could clear would reintroduce exactly the "configured in a second
  // place" problem this change exists to remove.
  //
  // A stat is ~1us and only happens on the provider path, not per byte of a
  // request. Same-millisecond edits are the one case mtime misses; a profile
  // switch writes the file, and `clearProfileBinding` covers the rest.
  const mtime = activeProfileMtime(resolvedHome);
  if (cached && cached.home === resolvedHome && cached.mtimeMs === mtime) return cached.profile;

  const name = readActiveProfileName(resolvedHome);
  if (!name) {
    throw new NanitesError({
      code: "no_active_profile",
      message:
        "nanites-router reads the ACTIVE profile's provider keys, and no active profile is set. " +
        "Create and activate one (the Providers tab, or /nanites-new-profile), then restart the router.",
      retryable: false,
    });
  }
  cached = { home: resolvedHome, profile: name, mtimeMs: mtime };
  return name;
}

/** mtime of the active-profile pointer, or 0 when there is no file. */
function activeProfileMtime(home: string): number {
  try {
    return statSync(path.join(home, "active_profile.json")).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Drop the cache. Needed between tests that use different homes — a stale
 * binding would silently route one test's keys into another's rows. A real
 * profile switch does not need it, because the mtime check catches that.
 */
export function clearProfileBinding(): void {
  cached = null;
}

/** The active profile's name, or null. No cache, no throw. */
export function readActiveProfileName(home: string): string | null {
  try {
    const raw = readFileSync(path.join(home, "active_profile.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    // A missing active_profile.json is the FIRST-RUN state, not an error.
    return null;
  }
}

function defaultHome(): string {
  return path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".", ".nanites");
}
