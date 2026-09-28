# nanites-router — Design

**Status:** locked, pre-implementation
**Date:** 2026-09-29
**Repo:** `Nanites-Public`

---

## 1. What this is

A lightweight HTTP gateway that puts **one URL and one virtual API key** in front of every
model account a user owns — local LM Studio, Cloudflare Workers AI, OpenRouter, NVIDIA NIM, and
any number of OpenAI-compatible generic gateways. An agent harness (Claude Code, Hermes, or any
OpenAI/Anthropic-shaped client) points at that one endpoint and never learns that more than one
provider, key, or model exists.

It is a second binary in the existing `nanites` package, not a second project. The provider
clients, key store, error taxonomy, discovery, and dashboard patterns all already exist and are
reused rather than rebuilt.

## 2. The problem it solves

Configuring an agent harness against N providers means N endpoint variables, N key values, and
no fallback logic. A rate limit on one account becomes a failed task. Adding a model means
editing harness config. There is no place to see which account is healthy.

`nanites-router` collapses that into one surface and owns the failure handling.

## 3. Locked decisions

These were decided with the user and are not to be re-litigated without flagging.

| # | Decision |
|---|---|
| D1 | **Same repo, second bin.** `nanites-router` in the `nanites` package, sharing `src/providers/` and `src/storage/`. New tables in the same `nanites.db`. |
| D2 | **One virtual key, full access.** A single user-set or auto-generated bearer key. No per-key scopes, no multi-tenant concept. |
| D3 | **Global, router-owned config.** Router config is not tied to a Nanites profile. Lives in the same `nanites.db`, in its own tables. |
| D4 | **Sticky = last-best upstream (provider, key) pair**, scoped per model. Not per virtual key, not per conversation. |
| D5 | **Failover stays inside the named provider.** All keys on that provider are tried; if the provider is fully dead, the router returns a structured error. It does **not** silently fall through to a different provider. |
| D6 | **Both inbound dialects with full streaming**: `POST /v1/messages` (Anthropic) and `POST /v1/chat/completions` (OpenAI), each translating to and from the internal representation and to the outbound provider. |
| D7 | **Model chains are ordered fallback, stop on first success.** The first candidate that returns a real answer wins and becomes sticky. No racing. |
| D8 | **Modality API is async job + SSE progress stream.** Submit, get a job id, subscribe to progress, retrieve the artifact. |
| D9 | **All four modality families in scope**: audio→text, image→text, video→text, and the generation legs (text→speech, text→image, text→video, image→image). |
| D10 | **Laya and Needle 3 are opt-in nice-to-haves.** The router must be fully functional with neither installed. They are served as catalog endpoints when present. |
| D11 | **Deterministic tool-call repair is the default**; model-assisted repair is opt-in and off by default. |
| D12 | **Control surfaces**: `nanites_*` MCP tools + a Router tab in the existing dashboard. CLI subcommands and new slash commands are out of scope for this phase. |
| D13 | **The router must work with no Claude harness running.** It is a standalone process. The MCP tools are a convenience, not a dependency. |
| D14 | **The orchestrator can retarget its own model via MCP tools** when it is itself pointed at the router. |
| D15 | **Docs only in this phase.** No code lands until the plan is approved. |

## 4. The two helper models, verified

Both were researched against their actual sources. The first pass of this design, written from
web-search results, got both models' identities wrong. Both corrections are recorded here because
both change the design.

### Needle — a real function-calling model, purpose-built for this

The user described it as "needle llm agentic model (Tiny Function-Calling AI)". The description is
essentially **correct**; my initial dismissal was wrong. It came from a search result pointing at
a Hugging Face org `NeedleAI` and a model `NeedleLLM-0.5B` — **neither of which exists.** Verified
against the HF API: `NeedleAI/NeedleLLM-0.5B` returns `Repository not found`, and the `NeedleAI`
org returns 404. Searching the actual publisher turns up the real model.

**`Cactus-Compute/needle3`** — Apache-2.0, **121M parameters**, ~90k downloads, from Cactus
Compute (needle.ai is their site). A Laddered Simple Attention Network: a Monarch Hadamard MLP in
place of the FFN, GQA attention with causal conv taps, engram n-gram memory, multi-lane
hyper-connections. Its capacity is a **ladder** — every depth from 2 to 20 layers is a deployable
model, and most parameters sit in the engram, so the 121M model does the arithmetic of a 50M one.
Weights are compressed to roughly 2.125 bits per weight; the whole model is a single 8-29 MB
file. Distilled from Gemini 3.1, post-trained on 2B tokens of function-call data.

It does three jobs, and **all three are ones this project needs**:

| Job | What it does | Why it matters here |
|---|---|---|
| **Tool calls** | Given the exposed functions, picks the right ones and fills every argument from what was said. Multiple asks produce multiple calls in order. An ask no tool covers returns an **empty list, not a guess** | Directly what R6 wants |
| **Structured extraction** | Declare a shape, hand it messy text, get typed fields back. A **byte-level grammar compiled from your schemas constrains every token**, so the output is guaranteed to parse | Schema-guaranteed output beats repair |
| **Text embedding** | The same model returns a sentence vector for local search, match, and route | Catalog and transcript retrieval |

It also returns a **calibrated confidence score** from a learned head, which is the missing piece
for routing: a number to threshold on rather than a guess. Its card claims it beats models 10x its
size on mobile tool calls and matches 2-3x larger models on extraction, and that fine-tuning lifts
every subnetwork by 18-36 points — from 4 layers up, a tuned subnetwork passes DeepSeek V4 Flash.

Serving it needs no Python at all. The repo ships a **sub-1MB engine per platform** — including
`windows-x86_64/needle.exe` — plus C API static libraries, a WASI component, and a browser build:

```sh
needle --model needle3.cact --tools tools.json --prompt "dim the living room to 30"
needle --model needle3.cact --tools tools.json --serve
```

A `win_amd64` wheel exists for `pip install cactus-needle`. The adapter shells out to a
subprocess, exactly as the Laya adapter does — no embedded Python, no WASM runtime, no added npm
dependency.

**This changes R6.** The ladder is not "deterministic first, maybe a generic small model last". It
is: deterministic repair first (free, exact, handles the mechanical malformations), then
**Needle 3 specifically** for semantic repair — a purpose-built tool-caller whose grammar is
compiled from the actual tool schema, and which returns an empty list rather than inventing a
call. That is a materially different risk profile from a general-purpose 0.5B model.

### Laya — a calibrated decision model, and the right one

The user called it "laya (open source jev)". That is close to right: Laya is a **successor in the
same family as TypeSafe Jev**, and its own card benchmarks against "TypeSafe Jev 1.13.0".

**`convaiinnovations/laya`** — Apache-2.0, 421M parameters (395M ModernBERT-large encoder + a 26M
decision head), **non-generative**. Its own card: *"It never generates text, so there is nothing
to parse and nothing to hallucinate."* Single forward pass in ~33ms. Typed questions defined
per-request — `choice`, `score`, `noul` — against arbitrary state, returning calibrated
probabilities. Served over `POST /v1/systemone` via `pip install laya` (currently 0.3.21), or
loaded in-process.

It cannot repair a malformed tool call, because it emits no text. It is excellent at
classification, which is most of what the router actually needs.

**Use `convaiinnovations/laya-typed-decisions`, not the base checkpoint.** This matters and was
nearly missed: the base English checkpoint scores **0.362** accuracy on typed decisions, while the
typed-decisions checkpoint scores **0.766** — above the 0.735 teacher self-agreement ceiling, and
2.4x better on Brier score than Jev's published 0.727. The base checkpoint is a weak zero-shot
model and would have quietly made the router's decisions worse. The `-multilingual` sibling is
mmBERT-base, 322M, 1024 ctx, 100+ languages.

### Where each one actually earns its place

| Router job | Needle 3 | Laya (typed-decisions) |
|---|---|---|
| Semantic tool-call repair | **yes** — grammar compiled from the real schema | no — emits no text |
| Schema-guaranteed structured output | **yes** — grammar constrains every token | no |
| Tool selection from a catalogue | **yes** — empty list when nothing fits | partial |
| Text embedding / retrieval | **yes** | no |
| Pick the provider for a request | partial | **yes** — calibrated `choice` |
| Score a key before sending | partial | **yes** — `score` primitive |
| Classify incoming modality | partial | **yes** — `choice` over modality labels |
| Validate a reply (refusal? tool call? garbage?) | partial | **yes** — 33ms, no parse risk |

They barely overlap, which is convenient: Needle is a *generator* on a tight schema, Laya is a
*classifier* over arbitrary state. Both are optional, and both are adapters behind one interface.

### Tool-call repair is still deterministic-first

Current code silently discards the failure. `parseToolCalls` (`src/providers/client.ts:102-127`)
parses `arguments` as a JSON string and falls back to `{}` when it is malformed — a tool call
that then runs with empty parameters, or a crash inside the tool. Needle does not change that the
mechanical cases should be handled without a model:

1. **Balanced-brace / balanced-quote extraction** — find the outermost `{...}` that parses,
   ignoring braces inside string literals. This alone fixes the common "model wrapped the JSON in
   prose", code-fenced, and trailing-comma cases.
2. **`JSON.parse`** with a small set of pre-corrections (trailing commas and Python
   `None`/`True`/`False` are safe; single-to-double quotes generally is not).
3. **Schema validation** against the declared tool's input schema. If every required field is
   present and no additional property is present, the call is good regardless of cosmetics.
4. **Only then**, and only when enabled: Needle 3 re-derives the call from the assistant's prose
   with the schema compiled into its grammar. Off by default (D11) — but unlike a generic small
   model, its empty-list behaviour makes a wrong answer far less likely.
## 5. Architecture

```
                    ┌──────────────── nanites-router (HTTP, standalone process) ───────────────┐
  Claude Code ──┐   │                                                                             │
  Hermes ───────┼──▶│  /v1/messages            /v1/chat/completions        /v1/models          │
  any OpenAI ───┘   │      │                        │                          │               │
                    │      ▼                        ▼                          ▼               │
                    │  ┌───────────  INBOUND  ───────────────┐    ┌────────────────────┐         │
                    │  │ auth (one virtual key)              │    │ catalog projection │         │
                    │  │ wire decode (Anthropic|OpenAI)     │    │ alias → chain      │         │
                    │  │ modality classify                   │    │ advertised subset  │         │
                    │  │ alias resolve                       │    └────────────────────┘         │
                    │  └───────────────┬─────────────────────┘                                    │
                    │                  ▼                                                          │
                    │  ┌───────────  CORE  ─────────────────┐                                     │
                    │  │ IR (intermediate representation)   │                                    │
                    │  │ chain walker (ordered, sticky)     │                                    │
                    │  │ key selector (strategy + sticky)   │                                    │
                    │  │ tool-call repair (deterministic)   │                                    │
                    │  │ observer (Laya, opt-in)            │                                    │
                    │  └───────────────┬─────────────────────┘                                    │
                    │                  ▼                                                          │
                    │  ┌───────────  OUTBOUND  ──────────────┐                                   │
                    │  │ wire encode (OpenAI-family)         │                                   │
                    │  │ existing ProviderClient × 5         │                                   │
                    │  └───────────────┬─────────────────────┘                                   │
                    └──────────────────┼──────────────────────────────────────────────────────────┘
                                       ▼
                        LM Studio · Cloudflare · OpenRouter · NVIDIA NIM · generic × N
```

### The intermediate representation

Everything between the wire boundary and the providers is one internal shape. Both inbound
dialects decode into it; every provider encodes out of it. This is the single most important
structural decision in the design: it is what makes D6 possible at all, and it is why the
Anthropic streaming contract is the highest-risk item in the whole project.

The IR is close to the existing `ChatRequest` (`src/providers/types.ts`) with additions:

- `content` parts gain an `input_audio` kind and a `video_uri` kind
- responses gain a multimodal result: text, or `{kind:"image"|"audio"|"video", uri, mime, ...}`
- `tools` are stored in OpenAI function form, and the Anthropic `input_schema` shape is a decode
  target only
- a `stop_reason` is carried and mapped per dialect (`end_turn` / `max_tokens` / `tool_use` ↔
  `stop` / `length` / `tool_calls`)

### Why a router and not a LiteLLM dependency

LiteLLM does the same category of work. This project builds it because the provider clients,
the Cloudflare error-code quirks (`6293` rate limit vs `4006` quota exhaustion, measured
2026-09-10), the key-exhaustion semantics, the discovery flow, and the dashboard are already
written and already tested here. Depending on LiteLLM would mean porting none of that and
reimplementing all of it later anyway when the requirements diverge.

## 6. Key selection

The store already supports everything D5 needs: `provider_api_keys` is keyed
`(profile_name, provider, key_id)`, so multiple keys per provider already work, and
`availableKeys()` already filters on `is_enabled`, `is_exhausted`, and `exhausted_until`.

Existing behaviour, retained:

- `recordFailure` retires a key after 3 consecutive failures for 5 minutes
- `QUOTA_EXHAUSTED` retires the key until the next UTC midnight
- other key-scoped errors (`AUTH`, `INSUFFICIENT_CREDITS`, `FORBIDDEN`) retire for 24 hours
- a persisted round-robin cursor lives in `provider_key_state`

New for the router:

- **usage-based exhaustion** — the user asked for "keep using one key until it returns rate
  limit or quota is up". This means counting requests and tokens per key and adding a
  user-configured budget that trips `exhaustKey` before the provider does.
- **sticky last-best** (D4). After a success, record `(provider, model_id, key_id)`. The next
  request for that model prefers that key. It is released when the key is retired, when the
  sticky pointer's TTL lapses, or when the key's failure count climbs.
- **per-key observability** — request count, token totals, last success, last failure, current
  consecutive failures, average latency, and cumulative spend. None of this exists today.

Strategies: `random`, `round_robin`, `usage_failover`, `sticky_last_best`. Sticky composes with
the other three rather than replacing them: it is the preference, and the strategy is the
fallback when the preferred key is unavailable.

## 7. Model aliases and chains

An alias maps to an ordered chain of candidates (`nanites-flash`, `nanites-mini`,
`nanites-pro` are the presets the user named; the set is open). The router walks the chain in
order and stops at the first candidate that returns a real answer (D7). The winner is recorded
as sticky so subsequent requests skip the failed candidates.

Users also pick **which models to advertise**. `/v1/models` returns only the advertised subset,
so a harness pinging the catalog does not receive hundreds of consolidated models. Each
advertised entry can carry a **harness-safe alias**, which is what makes the catalog usable by
clients that only accept their own naming convention.

A candidate in a chain is a real `(provider, endpoint, model_id)` triple from the consolidated
catalog — not a free-text string. A chain referencing a model that is not in the catalog is a
configuration error and is rejected at write time, not at request time.

## 8. Modality routing

The modality matrix, as the user specified it:

| In \ Out | text | audio | image | video |
|---|---|---|---|---|
| **text** | direct | generate | generate | generate |
| **audio** | transcribe → text | direct | direct | — |
| **image** | caption → text | direct | direct | direct |
| **video** | transcribe/caption → text | — | — | direct |

The direct cells are filled by a model that natively accepts that input and emits that output. If
no such model is advertised, the request is routed to the convert-then-route path: transcribe or
caption the input with a capable model, then route the resulting text to the target modality.
When both are possible, the direct path wins — it is one hop instead of two.

Users can pin a specific model per (source, target) cell, and the orchestrator can set those pins
through MCP tools (D14).

### This is entirely greenfield

`provider_models.supported_modalities` is only ever written `["text"]` or `["image","text"]`
(`src/storage/providerModelStore.ts:60-65`), and `ProviderCapabilities.audio` / `.video` are read
nowhere outside their type declarations. The capability flags exist in the schema and are
unimplemented. Every leg in the table above is new work, and the generation legs additionally
depend on what the configured providers actually advertise — OpenRouter exposes image, audio,
and video through `modalities` on `/api/v1/chat/completions` rather than through separate
`/v1/images/generations`-style endpoints, which is a different response shape from chat
completions and needs its own encode/decode path.

### Long-running generation (D8)

Text→video and text→audio take minutes. Holding an HTTP connection is not viable. The shape is:

```
POST /v1/jobs            {modality, model, input}   → {job_id, status:"queued"}
GET  /v1/jobs/:id/events                              → SSE progress frames
GET  /v1/jobs/:id                                   → {status, artifact|error}
DELETE /v1/jobs/:id                                 → cancel
```

Jobs survive a router restart — they are rows, not memory — and reuse the existing job-recovery
pattern in the repo. Progress percentage is whatever the provider exposes; where it exposes
nothing, the stream emits phase transitions (`queued` → `running` → `finalizing`) rather than
fabricating a percentage.

## 9. Tool-call repair

D11: deterministic first, model-assisted opt-in.

The repair ladder in §4 is implemented unconditionally, and it closes a real existing bug —
today a malformed `arguments` string becomes `{}` and the call proceeds with empty parameters.

The optional model-assisted rung is a separate, clearly-gated path, and it targets **Needle 3**
specifically (§4) — a purpose-built tool-caller with the schema compiled into its grammar, not a
general-purpose small model. It is never in the default request path. A caller who enables it
accepts that a wrong call is possible, though Needle's empty-list-on-nothing-fits behaviour makes
it far less likely than a generic model.

## 10. Helper models (D10)

Both are strictly optional. The router's core — auth, translation, chains, keys, modality
routing — never imports them. Absence is detected at startup and logged once; every code path
that would use a helper has a defined fallback.

**Needle 3** (`Cactus-Compute/needle3`), when installed, is a *generator* on a tight schema:

- semantic tool-call repair, as rung 4 of the ladder in §4
- schema-guaranteed structured output for job artifacts and pinned configuration reads
- text embedding, for pulling relevant slices out of a very long transcript or a very large
  consolidated catalog before those reach a frontier model
- its calibrated confidence score as a route-or-decline signal

It is also advertised in `/v1/models` as an endpoint. It is invoked by shelling out to the
per-platform engine binary (`needle.exe` on Windows), so there is no Python and no new dependency.

**Laya** (`convaiinnovations/laya-typed-decisions` — not the base checkpoint), when installed, is
a *classifier* over arbitrary state:

- modality classification when the caller does not declare it
- provider scoring before dispatch
- reply validation (is this a refusal, does it contain a tool call, is it degenerate)
- "should I re-ask this model or move down the chain" as a calibrated `score` question

It is also advertised in `/v1/models` as an endpoint. It is invoked over
`POST /v1/systemone` on a local server, or loaded in-process.

**Serving them** is a consequence of the gateway existing, not a separate feature: they are
ordinary catalog entries with an adapter that turns their non-standard interface into the
internal IR. A `choice` result becomes text content, a `score` becomes a number, and a
calibrated confidence becomes a routable signal rather than prose.

## 11. Inbound auth (D2)

One bearer key. User-set or auto-generated on first start. Presented by every harness. Compared
in constant time, reusing the existing `tokensMatch` in `src/ui/guards.ts`. There is no second
secret and no per-caller scope.

The dashboard's per-boot LAN token and its broadcast mode are **not** reused for the router. The
router is a different trust boundary: a broadcast dashboard is a read-mostly admin surface on a
trusted LAN, while a broadcast router endpoint is an inference surface with real spend behind it.

## 12. Transport

**Direct port listening** (always) and **cloudflared quick tunnel** (opt-in):

```
cloudflared tunnel --url http://localhost:4800
```

assigns a `https://random-words.trycloudflare.com` URL with no Cloudflare account and no config
file. The router shells out when the user enables tunnelling, parses the assigned hostname, and
surfaces it. There is no tunnel lifecycle management beyond start, show URL, stop — a named-tunnel
config, DNS records, and ingress rules are explicitly out of scope.

Default port: **4800**, deliberately distinct from the dashboard's 4700 so both can run.

## 13. The orchestrator using the router (D14)

When the orchestrator is itself pointed at `nanites-router`, it needs to be able to change which
model it is talking to. The `nanites_*` MCP tools expose that: read the advertised catalog, set
an alias chain, pin a modality route, and — for a harness that supports it — retarget. The router
never requires Claude to be running (D13); every one of these is a convenience over state that
lives in the database.

## 14. Storage

New tables in the existing `nanites.db`, all prefixed `router_`:

| Table | Purpose |
|---|---|
| `router_config` | singleton row: virtual key hash, port, tunnel state, default strategy |
| `router_keys` | per-key metrics: counts, tokens, spend, latencies, last success/failure |
| `router_aliases` | alias name → ordered candidate chain |
| `router_advertised` | which catalog models are advertised, and under what alias |
| `router_modality_pins` | (source, target) → pinned model |
| `router_jobs` | async modality jobs and their state |
| `router_sticky` | (model_id) → last-best (provider, key_id), with TTL |

The virtual key is stored **hashed**, unlike provider keys which are plaintext today. The router
accepts a caller's key on every request and never needs the original, so there is no reason to
store it reversibly. This is a deliberate inconsistency with the existing key store, and it is
noted in the spec as a known difference rather than quietly ignored.

## 15. What is explicitly not being built

- Multi-tenant accounts, per-caller quotas, per-caller billing
- Named Cloudflare tunnels, DNS, ingress configuration
- A/B testing or shadow traffic between models
- Semantic caching of responses
- Any change to the existing Nanites MCP tool behaviour — the router is additive
- Key encryption at rest for the existing `provider_api_keys` table (a separate, worthwhile
  project; not smuggled in here)
