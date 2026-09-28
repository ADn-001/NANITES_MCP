# Phase R0 — Router Foundation

**Goal:** a second binary that starts, authenticates, and serves `/v1/health` — with no inference
working yet. This phase exists to prove the packaging, the process model, the storage namespace,
and the security posture before any protocol work lands on top of it.

**Depends on:** nothing.
**Blocks:** R1 onward.

---

## Why this is a phase and not a task

Three decisions carry real risk and are cheapest to get wrong early:

1. **The global pseudo-profile** (`__router__`). If `create_profile` accepts that name, the
   reservation is not a reservation and a user profile can collide with router state. This is a
   one-line guard that is very easy to forget in six months.
2. **The second bin.** `copy-server.mjs` copies the build into `plugin/nanites/dist/` because
   Claude Code refuses a plugin path that escapes the plugin dir. A second entry point has to
   survive that copy, and the earlier `copy-ui.mjs` incident — where a prune deleted the compiled
   UI server and broke the stdio handshake with `cross-spawn/lib/enoart.js` ENOENT — is the
   precedent for checking this rather than assuming it.
3. **The hashed virtual key.** It is the only secret in the router, and the only one stored in a
   form that cannot be recovered.

---

## Implementation directions

### R0.1 — Bin and process

- `src/router/main.ts`: a standalone entry point. It calls `ensureNanitesHome()`, opens the
  database through the existing path helpers, runs migrations, then starts the HTTP server. It
  must **not** import `src/index.ts`, must not construct an MCP server, and must not touch the
  LM Studio lifecycle.
- Add the `nanites-router` bin and the `router` / `router:dev` scripts to `package.json`.
- Verify `scripts/copy-server.mjs` carries the new entry point into `plugin/nanites/dist/`, and
  that its asset-prune logic does not delete compiled `.js` files. The prune must stay scoped to
  image assets.
- Startup log: one line per material fact — port, bind address, whether a virtual key was
  supplied or generated, tunnel state, whether helper models were detected. No secrets in any
  log line.

### R0.2 — Storage

- Add migration **v25** (next free after the current head). It creates the `router_*` tables from
  §12 of the spec. Declare it **after** the last existing entry in the array — the ordering
  mistake in the v24 work cost nine test failures and is documented in that migration's comment.
- Seed exactly one `router_config` row (`id = 1`) on creation.
- Add `ROUTER_PROFILE = "__router__"` as an exported constant in a single module, and import it
  everywhere rather than re-typing the string.
- In `create_profile`, reject `"__router__"` with `invalid_profile_name`.

### R0.3 — Virtual key

- `hashVirtualKey(key)`: scrypt over the key with a per-install salt from `router_config.key_salt`.
- Startup resolution, in order: `NANITES_ROUTER_KEY` env → existing `virtual_key_hash` → generate,
  persist, and print once to stdout.
- `verifyVirtualKey`: constant-time compare, reusing the existing `tokensMatch` in
  `src/ui/guards.ts`. Reject before any body is read.
- Return the dialect's native error shape on rejection, not a generic one (§3.2 of the spec).
  An OpenAI client parses `{"error":{"message","type","code"}}`; an Anthropic client parses
  `{"type":"error","error":{...}}`. Getting this wrong produces a confusing client-side error
  that looks like a protocol bug.

### R0.4 — Server skeleton and guards

- `src/router/server.ts`: `node:http`, no framework, matching the style of `src/ui/server.ts`.
- Routes: `GET /v1/health`, `GET /v1/keys`, and a 404 for everything else. The full route table
  lands in R1.
- Every request passes, in order: virtual-key auth → outbound-URL guard → body-size limit →
  handler. The existing `assertOutboundUrl` SSRF guard and the body-size cap from
  `src/ui/server.ts` are reused.
- Bind `127.0.0.1` by default. `NANITES_ROUTER_BIND=0.0.0.0` is the only way to widen it, and
  the widened case logs a warning, mirroring the dashboard's broadcast warning.
- Dialect detection: presence of an `anthropic-version` header selects Anthropic, otherwise
  OpenAI. It is a single helper used by every future handler.

### R0.5 — Health

`GET /v1/health` returns router uptime, port, bind, key-present (boolean, never the key),
per-provider key counts, advertised/alias counts, tunnel state, and helper availability. This is
also the endpoint `nanites_router_config` reads.

---

## E2E test plan

`test/phaseR0/routerFoundation.test.ts`

1. **Startup** — `buildRouterDeps(scratchHome())` returns a server on an ephemeral port; assert
   `GET /v1/health` returns 200 with the expected shape.
2. **Virtual key generation** — first start with no env and an empty db writes a `router_config`
   row with a non-empty `virtual_key_hash`, and the plaintext key is recoverable only from the
   captured stdout. Assert the plaintext is **not** in the database: `SELECT * FROM router_config`
   contains no value that authenticates.
3. **Env-supplied key wins** — with `NANITES_ROUTER_KEY` set, the env key authenticates and the
   persisted hash matches it.
4. **Rejection** — a missing key, a wrong key, and a key that is a prefix of the real one all
   return 401 in the dialect-correct body shape. The prefix case is the constant-time comparison
   test and is worth keeping.
5. **Profile reservation** — `create_profile({name:"__router__"})` throws
   `invalid_profile_name`; `"__router"` (no trailing underscores) succeeds.
6. **Migration** — migrate a copy of a v24 database and assert `PRAGMA user_version` is 25, all
   seven `router_*` tables exist, and exactly one `router_config` row is present. Assert the
   migration array is ordered `…, 24, 25`.
7. **Packaging** — assert `package.json` declares the `nanites-router` bin, and that a build
   produces `dist/router/main.js`.
8. **Isolation** — two routers on separate `NANITES_HOME`s share nothing; a key added to one is
   invisible to the other.
9. **No regression** — the full existing suite (1137 tests) still passes. Specifically
   `test/phase38/plugin.test.ts`, which asserts the plugin build layout, and
   `test/phase3/storageLocation.test.ts`.

**Non-vacuity discipline.** Every test above was written to fail first. In particular, the
prefix-key test passes against a `===` comparison, so it must be shown failing against one
before it is trusted.

---

## Success criteria

- `npm run router` starts, prints one line, serves `/v1/health` on 4800, and stops cleanly.
- The plugin build contains a working router entry point, and `dist/index.js` still starts —
  the two-entry-point packaging is proven in CI, not by inspection.
- `create_profile` refuses `__router__`.
- The virtual key is hashed at rest; a full-text scan of `nanites.db` for the key finds nothing.
- The existing suite is green and unchanged.
- Outbound URL validation and the body-size cap are on the request path before any handler runs.
