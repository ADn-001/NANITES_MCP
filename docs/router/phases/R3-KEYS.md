# Phase R3 — Multi-Key Selection

**Goal:** multiple keys per provider, all four strategies, sticky last-best, per-key metrics and
budgets. This is the phase that delivers the core promise: an account failure is invisible to the
caller.

**Depends on:** R1 (R2 recommended but not required).

---

## What already exists

Do not rebuild these — they are in `ProviderKeyStore` and the router's adapter layer:

- multiple key rows per provider (PK is `(profile_name, provider, key_id)`)
- `availableKeys()` filtering on `is_enabled`, `is_exhausted`, `exhausted_until`
- `recordFailure` → auto-exhaust at 3 consecutive failures for 5 minutes
- `clearExhaustion` on success
- `exhaustKey(until)` for an explicit retirement window
- a persisted round-robin cursor in `provider_key_state` (`getKeyState` / `saveKeyState`)
- the router's failure classification: `QUOTA_EXHAUSTED` retires to next UTC midnight; other
  key-scoped codes retire for 24 hours (`src/providers/router.ts:337-344`)

## What is new

Everything about **preference** rather than **eligibility**, plus all per-key observability,
which does not exist today in any form.

---

## Implementation directions

### R3.1 — `nvidia` as a fifth provider

Add `ProviderKind` = `"nvidia"` and a `NvidiaClient` mirroring `OpenRouterClient` — same bearer
auth, same `/models` and `/chat/completions` paths, default
`https://integrate.api.nvidia.com/v1`. No reasoning-field special-casing; NIM takes plain
OpenAI params. An `account_id` is accepted and ignored so a config carrying one does not fail
validation.

This is a small phase item but belongs here rather than in R0, because a provider kind with no
key-selection story is untestable in a meaningful way.

### R3.2 — Key metrics table

Migration **v26**: `router_key_metrics` per §12 of the spec. Record on every dispatch:

- `request_count`, `error_count`
- `input_tokens`, `output_tokens`, `spent_usd` (reusing the existing `computeCost`,
  `src/providers/router.ts:497-509`, which returns `undefined` rather than guessing when pricing
  is unknown — the metric must stay null in that case rather than becoming zero)
- `avg_latency_ms` as a rolling mean
- `last_success_at`, `last_failure_at`
- `usage_threshold`, the optional per-key budget in requests

Writes are per-request. Batch them or use a write queue if a hot key shows up in profiling —
`node:sqlite` is synchronous, and a synchronous write on the request path is a latency floor.

### R3.3 — `selectKey`

`src/router/keys/selector.ts` per §5 of the spec. A pure function over `KeyCandidate[]` — no
store access, no I/O — so all four strategies are testable without a database.

- **`random`** — uniform over eligible candidates.
- **`round_robin`** — the existing persisted cursor, extended to the candidate set rather than the
  raw key list. The existing implementation has a real subtlety here: it prefers untried
  `key_id`s via a `Set` rather than an index, because the pool can shrink mid-run and an index
  would skip a neighbour. Preserve that property.
- **`usage_failover`** — pick the **most**-used key still under budget. This is deliberate and
  counter-intuitive: it is the "keep using one until it is done" behaviour, and spreading load
  across accounts with per-account quotas is worse than saturating one. Once the ratio crosses
  `budget_threshold`, the key is excluded and the next one takes over. `usage_ratio` comes from
  `request_count / usage_threshold` when a budget is set; with no budget, the key with the fewest
  requests wins, which is a reasonable degenerate case.
- **`sticky_last_best`** — check `router_sticky` for the model; if that key is still eligible and
  its `turns_left > 0`, return it. Otherwise delegate to `fallback`.

### R3.4 — Sticky persistence

`router_sticky` rows keyed by model id, holding `(provider, key_id, turns_left)`. Written on
every success; `turns_left` decrements per use and is deleted at zero.

**Deleted immediately when:** the key is retired, the key's `consecutive_failures` climbs above
zero, or the model fails on that key. A sticky pointer to a degrading key is exactly the failure
mode this feature is meant to prevent, so the release conditions matter more than the set
condition.

### R3.5 — Provider-scoped failover (D5)

Failover is confined to the named provider. When all of a provider's keys are exhausted, return
`provider_key_required` naming the provider and the reason for each exhausted key. **It must not
fall through to another provider** — a different provider means a different model, a different
price, and a different quality, and silently substituting it is a decision the user did not make.

Assert this with a test that has two healthy providers, exhausts the named one, and asserts the
other was never contacted.

### R3.6 — Key configuration surface

`nanites_router_listKeys` and the dashboard's key-health panel. The key-vault UI from the
Providers tab is reused; the router tab adds the strategy selector, the per-key budget, and the
usage stats.

---

## E2E test plan

`test/phaseR3/keySelection.test.ts` — pure function, no I/O

1. **`random`** — with a seeded RNG, a 4-key pool over 1000 draws has a distribution within
   tolerance of uniform (chi-squared, not "all keys appeared").
2. **`round_robin`** — 12 draws over 4 keys hits each exactly 3 times, and the sequence continues
   across two calls via the persisted cursor.
3. **`round_robin` with a shrinking pool** — a key is retired mid-sequence. The remaining keys
   are all still reachable, and none is skipped. This is the `Set`-not-index property; it is
   exactly the bug that the existing `Set` approach was written to prevent, so it needs a test
   that fails if someone "simplifies" it back to an index.
4. **`usage_failover`** — with 3 keys at 40/35/25% of budget, the 40% key wins. At 95% with
   `budget_threshold: 0.9`, the 95% key is excluded and the 35% key wins.
5. **`usage_failover` with no budget** — the fewest-requests key wins.
6. **`sticky_last_best`** — after a success on key B, the next 5 selections are B; on the 6th, the
   fallback takes over.
7. **Sticky release** — three triggers tested separately: key retired; `consecutive_failures > 0`;
   TTL lapsed. Each must fall back.
8. **Endpoint scoping** — a `generic:<endpoint>:<model>` id narrows the pool to keys whose nickname
   matches, and a named endpoint with no key raises `endpoint_not_configured` without contacting
   any other key. (The existing router has this behaviour; the router must preserve it.)

`test/phaseR3/keyFailover.test.ts` — full path, stubbed fetch

9. **Single key, 429** — a retryable rate limit is retried on the same key with backoff, then
   succeeds. Assert the backoff actually happened (fake timers, not a sleep).
10. **Key A 401, key B healthy** — the client receives one successful response. **The 401 never
    reaches the client.** This is FR-2 in one test.
11. **All keys 402** — `provider_key_required` with every key's reason listed.
12. **Cross-provider isolation** — providers A and B both configured, A fully exhausted, a request
    for a model only B serves. The response names A's exhaustion and **B is never contacted**.
    Assert on the fetch stub's call log, not on the error message alone.
13. **Metrics accumulate** — across 5 requests, one with an error: `request_count` 5,
    `error_count` 1, tokens match the upstream, `spent_usd` is null when pricing is unknown
    (not zero).
14. **NIM provider** — a `nvidia` key pings, lists models, and completes a chat with the correct
    base URL and bearer header.

**Non-vacuity.** Test 12 is the one most likely to pass while broken: a router that fell through
to B would still return a *successful* response, so the assertion must be on the fetch call log.
Deliberately break the scoping and confirm the test catches it.

---

## Success criteria

- A request hitting a 401 on one key is served by another with no client-visible error.
- A request against a fully-exhausted provider returns a structured error naming each key's
  reason, and contacts no other provider.
- All four strategies behave as specified and are covered by pure-function tests.
- The sticky pointer converges after one failed request rather than paying a failed attempt on
  every subsequent request.
- Per-key request counts, tokens, spend, latency, and last success/failure are visible in the
  dashboard and in `GET /v1/keys`.
- `nvidia` works end to end.
- The existing suite is green and unchanged.
