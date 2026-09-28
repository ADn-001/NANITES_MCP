# Phase R4 — Aliases, Chains, and Advertised Catalog

**Goal:** model aliases with ordered fallback chains, the advertised-subset catalog, and
harness-safe naming. This is the phase that makes one endpoint look like one small set of models
rather than a wall of provider internals.

**Depends on:** R3.

---

## Implementation directions

### R4.1 — Discovery refresh on every test action

Requirement 5 from the user: configuring a provider populates its model catalog, and **every
test action refreshes it**. Wire this once, centrally, so no call site can forget:

```ts
// src/router/models/refresh.ts
export async function discoverAndRefresh(db, provider, key): Promise<number>
```

Call it from provider ping, key test, model test, and after a key is added. Return the model
count so callers can report "48 models discovered".

Two existing traps to avoid:

- **`discoverProviderModels` returns only the first 20 models** (`src/tools/providers.ts:118`).
  A router catalog that silently truncates at 20 is worse than one that returns everything, because
  the truncation is invisible. Lift the limit, or paginate and report the total.
- **The dashboard's per-provider discover silently swallows per-provider errors**
  (`src/ui/server.ts:1255-1258`). For the router, a discovery failure must be visible: return
  which provider failed and why. A provider that looks configured but silently has no catalog is
  a bad failure mode.

### R4.2 — Capability truth

`ProviderCapabilities` already declares `{vision, audio, video, function_calling, reasoning?}`
and `provider_models.supported_modalities` already has a column, but **nothing populates audio or
video** — `providerModelStore.ts:60-65` writes only `["text"]` or `["image","text"]` — and
nothing reads them.

For R4, populate capabilities from what discovery actually reports per provider, and treat
absent data as **unknown, not false**. A model whose modality support is unknown is not a
candidate for modality routing; that discipline is what R5 depends on.

### R4.3 — Aliases and chains

`router_aliases` (migration v27) and `src/router/models/aliases.ts` per §6 of the spec.

`walkChain` follows D7 exactly: sticky winner first if still valid, then candidates in order,
stopping at the first **real answer**. A real answer means non-empty content or a non-empty tool
call — the same emptiness test `isEmptyCloudReply` already applies.

Which failures move down the chain versus propagate is the part that needs care:

| Failure | Behaviour |
|---|---|
| key-scoped (`AUTH`, `INSUFFICIENT_CREDITS`, `FORBIDDEN`, `QUOTA_EXHAUSTED`) | next candidate |
| model-scoped (`MODEL_NOT_FOUND`, `AGREEMENT_REQUIRED`, `BUDGET_EXHAUSTED`) | next candidate |
| empty reply after budget retry | next candidate |
| rate limited, after retries | next candidate |
| timeout | next candidate |
| 5xx after retries | **propagate** |
| decode failure | **propagate** |

A chain exists to absorb "this model is unavailable right now". It is not a general error sink: a
provider that 500s on everything should fail visibly rather than silently burning four
candidates and four times the latency.

**Write-time validation** (FR-33): every candidate must resolve to a `provider_models` row. A
dangling reference is `alias_candidate_unknown` at write time, never a request-time surprise.
Validating lazily is the mistake the registry already made once.

### R4.4 — Advertised catalog

`router_advertised` and `GET /v1/models` per §7 of the spec.

An advertised entry pairs a **harness-safe alias** with a real namespaced id. The alias is what
makes the catalog usable by clients that only accept their own nomenclature — a Claude-shaped
harness that rejects `qwen/qwen3.8-27b:free` as a model id can accept `nanites-flash`.

`GET /v1/models` returns **only** advertised entries, rendered in the dialect the `anthropic-version`
header selects.

Presets: `nanites-flash`, `nanites-mini`, `nanites-pro` are created on first run with sensible
default chains (cheap/small → mid → large), fully editable thereafter. The defaults must reference
real catalog entries, so they are created lazily on first discovery, not at migration time.

### R4.5 — Resolution order

An inbound `model` is resolved in this order:

1. an advertised alias (exact match) → its chain
2. an advertised alias that is also a namespaced real id → direct
3. a bare model id unique across the catalog → direct
4. otherwise `alias_unknown`, listing the candidates when ambiguous

Rule 4 is the same trap the MCP server's `cloud_provider_required` fix walked into. Do not
rediscover it.

### R4.6 — MCP + dashboard

`nanites_router_setAlias`, `nanites_router_listAliases`, `nanites_router_setAdvertised`,
`nanites_router_listModels`. The dashboard's alias panel gets drag-to-reorder, a sticky-winner
indicator, and an inline candidate picker that only offers real catalog entries.

---

## E2E test plan

`test/phaseR4/catalog.test.ts`

1. **Discovery populates** — a stubbed `/models` returning 60 models; after ping, the catalog has
   60. **Explicitly assert the count is not 20** — the existing 20-limit is a real regression
   risk and the test must name it.
2. **Discovery failure is visible** — one provider fails to list; the response names it and its
   error. A test that only checks the other providers succeeded will pass while the user is left
   thinking a configured provider has no models.
3. **Every test action refreshes** — ping, key test, and model test each bump
   `last_refreshed`. Assert all three, not just ping.
4. **Alias chain: ordered fallback** — three candidates; the first 500s twice, the second 401s
   once, the third succeeds. Assert: candidates were tried in order, exactly one response came
   back, and the sticky winner is now the third candidate.
5. **Chain stops on first success** — the first candidate succeeds; candidates 2 and 3 are never
   contacted. Assert on the fetch call log.
6. **5xx propagates** — a single-candidate chain with a 500 propagates rather than walking.
7. **Sticky winner is preferred** — after test 4, a follow-up request goes straight to candidate
   3. Assert the fetch log contains only candidate 3.
8. **Dangling candidate rejected at write** — `setAlias` with a model not in the catalog throws
   `alias_candidate_unknown`. Assert the row was not written.
9. **Advertised subset** — a catalog of 200 models, 5 advertised; `GET /v1/models` returns
   exactly 5.
10. **Dialect rendering** — the same request with and without `anthropic-version` returns the two
    different shapes from §7 of the spec.
11. **Harness-safe alias** — the advertised id contains no `:` and no `/`; a strict client accepts
    it.
12. **Resolution order** — advertised alias, advertised real id, unique bare id, ambiguous bare id
    (→ `alias_unknown` naming both), and unknown (→ `alias_unknown`). Five cases, one test each.
13. **Presets** — first discovery creates `nanites-flash`/`mini`/`pro` whose candidates all resolve
    to real catalog rows.

**Non-vacuity.** Test 1 must be shown failing against the 20-limit. Test 5 must be shown failing
against an eager "try everything" walker. Both are the kind of thing that looks right until
measured.

---

## Success criteria

- Pinging a provider populates its catalog with **all** advertised models, not a truncated 20.
- Every test action refreshes the catalog.
- A discovery failure is reported, not swallowed.
- A three-candidate chain tries in order, stops at the first real answer, and remembers the winner
  so the next request skips straight there.
- A 500 propagates rather than being absorbed by the chain.
- Dangling chain references are rejected at write time.
- `/v1/models` returns only advertised models, in the caller's dialect, under safe names.
- MCP tools and the dashboard manage aliases and advertised models.
- The existing suite is green and unchanged.
