# nanites-router

A lightweight HTTP gateway that puts one URL and one virtual API key in front of every model
account you own — local LM Studio, Cloudflare Workers AI, OpenRouter, NVIDIA NIM, and any number
of OpenAI-compatible gateways.

Agent harnesses (Claude Code, Hermes, any OpenAI/Anthropic-shaped client) point at it and never
learn that more than one provider, key, or model exists behind it.

**Status: designed, specified, phased. Not implemented.** D15 — docs only until approved.

---

## Documents

| Doc | Contents |
|---|---|
| [`00-DESIGN.md`](00-DESIGN.md) | Architecture, the 15 locked decisions, and the correction of two wrong premises about the helper models |
| [`01-PRD.md`](01-PRD.md) | Goals, non-goals, user stories, 60+ functional requirements, risks |
| [`02-SPEC.md`](02-SPEC.md) | Interfaces, wire formats, IR types, storage schema, MCP tool list, error codes |

## Phases

| Phase | Delivers | Risk |
|---|---|---|
| [R0 — Foundation](phases/R0-FOUNDATION.md) | Second bin, storage, hashed virtual key, auth, server skeleton | Low |
| [R1 — Wire Layer](phases/R1-WIRE-LAYER.md) | IR, both inbound dialects, outbound adapter | **High** |
| [R2 — Streaming](phases/R2-STREAMING.md) | SSE for both dialects, Anthropic event state machine | **High** |
| [R3 — Keys](phases/R3-KEYS.md) | Multi-key selection, four strategies, sticky, metrics, NVIDIA NIM | Medium |
| [R4 — Catalog](phases/R4-CATALOG.md) | Discovery refresh, alias chains, advertised subset | Medium |
| [R5a — Modality Core](phases/R5A-MODALITIES-CORE.md) | Classification, capability data, planner, pins, audio/image legs, text->image | Medium |
| [R5b — Generation](phases/R5B-MODALITIES-GENERATION.md) | Video, long audio, async jobs, SSE progress. **Starts with a live probe** | **High** |
| [R6 — Tool Repair](phases/R6-TOOL-REPAIR.md) | Deterministic repair ladder, fixes a live silent-`{}` bug | Low |
| [R7 — Transport](phases/R7-TUNNEL.md) | cloudflared quick tunnel, rate limiting, key hygiene | Low |
| [R8 — Helpers](phases/R8-HELPERS.md) | Laya + Needle 3, fully optional | Low |

R1, R2, and R5b are the hard ones. R2 blocks everything that streams. R5b opens with a live probe
of the video endpoints, and what that probe finds decides how much of the phase gets built.

---

## Locked decisions

| # | Decision |
|---|---|
| D1 | Same repo, second bin (`nanites-router`), sharing `src/providers/` and `src/storage/`; new tables in the same `nanites.db` |
| D2 | One virtual key, full access. No scopes, no multi-tenancy |
| D3 | Global, router-owned config. Not tied to a Nanites profile |
| D4 | Sticky = last-best upstream (provider, key) pair, scoped per model |
| D5 | Failover stays inside the named provider. Never falls through to another |
| D6 | Both inbound dialects with full streaming |
| D7 | Chains are ordered fallback, stop on first success. No racing |
| D8 | Modality API is async job + SSE progress stream |
| D9 | All four modality families in scope |
| D10 | Laya and Needle 3 are opt-in nice-to-haves; fully functional without them |
| D11 | Deterministic tool-call repair by default; model-assisted is opt-in and off |
| D12 | Control surfaces: `nanites_*` MCP tools + a Router dashboard tab |
| D13 | The router works with no Claude harness running |
| D14 | The orchestrator can retarget its own model via MCP tools |
| D15 | Docs only until approved |

---

## The two helper models, verified

Both were researched against their actual sources with a Hugging Face token. The first pass was
written from web-search results and got **both identities wrong**. The user was right about both.

**Needle — `Cactus-Compute/needle3`, and it is exactly what was described.** Apache-2.0, **121M
parameters**, ~90k downloads, from Cactus Compute. A Laddered Simple Attention Network distilled
from Gemini 3.1 and post-trained on 2B tokens of function-call data. It does tool calls (picks the
right functions, fills every argument, and returns an **empty list rather than a guess** when
nothing fits), **schema-guaranteed structured extraction** (a byte-level grammar compiled from your
schemas constrains every token), and **text embedding** — and it carries a calibrated confidence
score. Capacity is a ladder: every depth from 2 to 20 layers is a deployable model.

The earlier draft dismissed it as "not a function-calling model" on the strength of a search result
pointing at `NeedleAI/NeedleLLM-0.5B`. **That org and model do not exist** — the org returns 404
and the model returns `Repository not found` from the HF API. The error is recorded because it is
instructive: a plausible search result pointing at a nonexistent repo is indistinguishable from a
real one until you call the API.

**Laya — `convaiinnovations/laya-typed-decisions`.** Apache-2.0, 421M (ModernBERT-large encoder +
decision head), **non-generative**, ~33ms per call, calibrated `choice`/`score`/`noul` questions.
Laya is a successor to **TypeSafe Jev** and benchmarks against it, which is where the description
came from. Use the typed-decisions checkpoint: the base English one scores **0.362** on typed
decisions, the typed-decisions one scores **0.766** — above the teacher self-agreement ceiling.

They barely overlap. Needle is a generator on a tight schema; Laya is a classifier over arbitrary
state. Both are optional; the router is complete without either.

**Tool-call repair is deterministic-first regardless.** Balanced extraction, safe coercions, schema
validation — free and exact. Needle is the opt-in fourth rung for semantic repair, and its
empty-list-on-nothing-fits behaviour makes it far safer to enable than a generic small model would
be. R6 also fixes a real bug: `parseToolCalls` currently turns malformed `arguments` into `{}` and
the call proceeds with empty parameters.

## What already exists and gets reused

This is a second bin in an existing package, not a rewrite. Reused as-is:

- 4 provider clients, all OpenAI-shaped (`src/providers/client.ts`) — NVIDIA NIM is a 5th kind
  mirroring `OpenRouterClient`
- The measured Cloudflare error taxonomy including the `6293` rate-limit vs `4006` quota-exhausted
  distinction (`src/providers/errors.ts:133-206`)
- Key store with multiple keys per provider already working, plus exhaustion, cooldown, and a
  persisted round-robin cursor
- Usage failover: 3 consecutive failures retires a key for 5 minutes; `QUOTA_EXHAUSTED` retires
  to next UTC midnight; other key-scoped errors for 24 hours
- Sticky model selection (`providerStickyStore`)
- Model catalog with a capabilities column and per-provider discovery
- Dashboard ping / key-test / model-test endpoints
- The cloud tool loop, fs sandbox, SSRF guard, constant-time token compare
- All 1137 existing tests

## What is greenfield

Verified absences, not assumptions:

- **No inbound inference surface at all.** Zero `/v1/chat/completions`, zero `/v1/messages`. Both
  `createServer` call sites in the repo are the dashboard.
- **No Anthropic⇄OpenAI translation anywhere.** This is the single biggest build item.
- No virtual key, no inbound auth, no tunneling, no aliases, no async job surface.
- **Audio and video are fiction.** `supported_modalities` is only ever written `["text"]` or
  `["image","text"]`, and the audio/video capability flags are read nowhere. The whole modality
  matrix is new work.

---

## Known inconsistency, deliberately

The router's virtual key is stored **hashed**. The existing `provider_api_keys` table stores
provider keys in plaintext, which the README honestly documents under known limitations. The
router accepts a caller's key on every request and never needs the original, so there is no reason
to store it reversibly. This inconsistency is noted rather than quietly ignored.

Encrypting the existing provider key table is a worthwhile separate project. It is not smuggled
into this one.
