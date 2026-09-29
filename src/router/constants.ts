/**
 * Router-wide constants that more than one module needs to agree on.
 *
 * The reserved profile name is the load-bearing one. Every store in this repo is
 * scoped by `profile_name`, and the router deliberately reuses those stores
 * rather than forking them — so the router's own rows live under a reserved
 * profile name. `createProfile` rejects it, which is what makes the reservation
 * a reservation rather than a convention someone can break by typing a name.
 *
 * Import it from here; never re-type the string.
 */
export const ROUTER_PROFILE = "__router__";

/**
 * Profile names the router reserves for its own use. Kept as a set so adding a
 * second reserved name later does not mean finding every call site.
 */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([ROUTER_PROFILE]);
