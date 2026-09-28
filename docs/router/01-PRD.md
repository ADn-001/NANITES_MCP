# nanites-router — Product Requirements

**Status:** locked, pre-implementation
**Companion to:** [`00-DESIGN.md`](00-DESIGN.md)

---

## 1. Problem statement

A user owns model access spread across several services: local LM Studio, Cloudflare Workers AI,
OpenRouter, NVIDIA NIM, and one or more self-hosted OpenAI-compatible gateways. They want an
agent harness — Claude Code, Hermes, or any OpenAI/Anthropic-shaped client — to use all of it
without the harness knowing that more than one exists.

Today, using more than one means configuring more than one endpoint in the harness, and the
harness has no notion of trying the next account when one is rate limited. The consequences are
concrete: a 429 becomes a failed task rather than a slow one; adding a model means editing
harness configuration; and there is nowhere to see which account is healthy or how much it has
cost.

## 2. Users

**Primary — the operator.** Runs the server on their own machine. Owns the provider accounts and
the API keys. Configures everything through the dashboard, MCP tools, or the config file. Wants
to stop thinking about key management.

**Secondary — the harness.** Claude Code, Hermes, or any SDK client. Never configured with
provider details. Presents one URL and one key. Must not be able to enumerate or address an
account it was not given.

## 3. Goals

| # | Goal | Success measure |
|---|---|---|
| G1 | One endpoint, one key, all providers | A harness configured with a single base URL reaches every configured provider |
| G2 | Account failures are invisible to the caller | A request that hits a rate limit or exhausted quota still returns a successful answer, as long as another key on that provider is healthy |
| G3 | Both client dialects work natively | Claude Code works unmodified; an OpenAI SDK works unmodified |
| G4 | Catalog stays small and legible | `/v1/models` returns only what the user advertised, with harness-safe aliases |
| G5 | Modality routing works across the full matrix | Audio, image, and video inputs route to the right leg; generation is possible where a provider supports it |
| G6 | Tool calls never silently lose their arguments | A malformed `arguments` payload is repaired or produces a clear error — never `{}` |
| G7 | Works with no helper models installed | Full functionality on a machine with neither Laya nor Needle 3 |
| G8 | The operator can see account health at a glance | Per-key request count, token usage, spend, latency, and last-success are visible in the dashboard |

## 4. Non-goals

- Multi-tenancy, per-caller quotas, or per-caller billing
- A managed or hosted service — this is a local-first tool that the operator runs
- Replacing Nanites' own MCP delegation flow; the router is additive
- Key encryption at rest for the pre-existing provider key table
- Named Cloudflare tunnels, DNS records, or ingress configuration
- Response caching, shadow traffic, or A/B testing
- Fine-tuning, hosting models, or managing provider-side quotas

## 5. Key user stories

**US-1 — One endpoint.**
As an operator with four provider accounts, I configure the router once and point Claude Code at
it. Claude Code can reach all four without any further configuration, and I never edit harness
config again when I add a fifth.

**US-2 — Transparent key failover.**
My Cloudflare key hits a rate limit mid-task. The request is retried on my second Cloudflare key
and the harness sees one successful response. It never sees the 429.

**US-3 — Explicit failure.**
Every key on the provider I named is exhausted. I get a clear, structured error naming the
provider and the reason. I am not silently given a different provider's answer, because a
different model would have a different price and a different quality.

**US-4 — Small catalog.**
My harness pings `/v1/models`. It gets eight models, not the four hundred my providers
collectively advertise. Each has an alias my harness accepts.

**US-5 — Cheap model chain.**
`nanites-flash` is a chain of three candidates. The first is rate limited on every call. After
the first request the router remembers and goes straight to the second, so subsequent calls do
not pay the failed attempt's latency.

**US-6 — Modality routing.**
I send a screenshot and a question. The router routes it to my vision model and returns text.
I ask for an image and the router routes to my image model and returns an image. Neither
requires me to have said which model to use.

**US-7 — Long generation.**
I ask for a 30-second video. The router returns a job id immediately, streams progress, and I
collect the artifact when it is ready. My connection is never held open for three minutes.

**US-8 — Tool-call repair.**
A small model returns a tool call whose arguments are valid-ish but wrapped in prose with a
trailing comma. The router repairs it and the call runs. It does not arrive at the tool as an
empty object.

**US-9 — Account health.**
I open the Router tab. I can see which of my six keys is serving traffic, what each has cost
this month, which are exhausted and until when, and which have been failing.

**US-10 — Optional intelligence.**
I install Laya. The router starts using it to pick providers and validate replies. Later I
uninstall it. Nothing breaks.

## 6. Functional requirements

### 6.1 Configuration

| ID | Requirement |
|---|---|
| FR-1 | The operator adds a provider with a name, one or more API keys, and optionally an account id and/or endpoint URL |
| FR-2 | NVIDIA NIM is available as a first-class provider preset pointing at `https://integrate.api.nvidia.com/v1` |
| FR-3 | Any OpenAI-compatible gateway is addable as a `generic` endpoint, unlimited in number |
| FR-4 | Configuring a provider triggers model discovery, which populates the catalog for that provider |
| FR-5 | Every test action (provider ping, key test, model test) refreshes that provider's catalog |
| FR-6 | Individual keys and account ids can be tested independently of the provider as a whole |
| FR-7 | A model can be added by id with optional context length and modality declarations, and tested with a generated arithmetic prompt |
| FR-8 | Models of other modalities are tested with an appropriate prompt for their modality |

### 6.2 Gateway

| ID | Requirement |
|---|---|
| FR-10 | `POST /v1/messages` accepts the Anthropic Messages format and returns an Anthropic response |
| FR-11 | `POST /v1/chat/completions` accepts the OpenAI Chat Completions format and returns an OpenAI response |
| FR-12 | Both endpoints support streaming, with correct SSE event sequencing for their dialect |
| FR-13 | All inbound requests require the virtual key; unauthenticated requests are rejected |
| FR-14 | The virtual key is either user-set or auto-generated at first start |
| FR-15 | Anthropic extended-thinking blocks are translated in both directions, including streaming deltas |
| FR-16 | Tool definitions and tool calls are translated in both directions, including parallel calls |
| FR-17 | `stop_reason` / `finish_reason` are mapped correctly per dialect |

### 6.3 Keys

| ID | Requirement |
|---|---|
| FR-20 | Multiple keys per provider are supported |
| FR-21 | The operator chooses the selection strategy: random, round robin, usage failover, or sticky last-best |
| FR-22 | Usage failover keeps using one key until a rate limit or quota error, then moves to the next |
| FR-23 | A usage budget can be set per key, tripping exhaustion before the provider does |
| FR-24 | The last successful (provider, key) pair is sticky per model and reused while healthy |
| FR-25 | Stickiness is released when the key is retired, the TTL lapses, or the key degrades |
| FR-26 | Failover is confined to the named provider; exhaustion of all its keys returns a structured error |
| FR-27 | Per-key request count, token totals, spend, average latency, and last success/failure are recorded |

### 6.4 Models

| ID | Requirement |
|---|---|
| FR-30 | An alias maps to an ordered chain of catalog models |
| FR-31 | The router walks the chain in order and stops at the first real answer |
| FR-32 | The chain winner is recorded as sticky so later requests skip known-bad candidates |
| FR-33 | Chains reference real catalog entries; a dangling reference is rejected at write time |
| FR-34 | `GET /v1/models` returns only the advertised subset |
| FR-35 | Each advertised model may carry a harness-safe alias |
| FR-36 | Preset aliases `nanites-flash`, `nanites-mini`, and `nanites-pro` are provided but fully editable |

### 6.5 Modalities

| ID | Requirement |
|---|---|
| FR-40 | Incoming modality is classified from request content when not declared |
| FR-41 | A natively multimodal model is preferred over a convert-then-route path |
| FR-42 | audio→text transcription is supported |
| FR-43 | image→text captioning is supported |
| FR-44 | video→text transcription/captioning is supported, **subject to the R5b probe** |
| FR-45 | text→image is supported where a provider advertises it; text→speech, text→video, and image→image are subject to the R5b probe |
| FR-46 | Models can be pinned per (source, target) modality cell |
| FR-47 | The orchestrator can set and change modality pins through MCP tools |
| FR-48 | Long generation requests are async jobs with SSE progress; short ones (text→image) return inline |
| FR-49 | Jobs survive a router restart |
| FR-50 | The orchestrator can read the router's catalog and retarget its own model through MCP tools |

### 6.6 Control surfaces

| ID | Requirement |
|---|---|
| FR-60 | `nanites_*` MCP tools manage router config: keys, strategies, aliases, advertised models, pins, and health |
| FR-61 | A Router tab in the dashboard shows virtual key, key health, alias chains, advertised models, and pins |
| FR-62 | The Router tab can ping providers, test keys, test models, and trigger discovery |
| FR-63 | The router runs and serves with no MCP client connected |

### 6.7 Transport

| ID | Requirement |
|---|---|
| FR-70 | The server listens on a direct port, default 4800 |
| FR-71 | A cloudflared quick tunnel can be enabled, disabled, and its URL surfaced |
| FR-72 | Tunnelling is opt-in and off by default |

### 6.8 Tool calls

| ID | Requirement |
|---|---|
| FR-80 | Malformed tool-call arguments are repaired by a deterministic ladder before execution |
| FR-81 | Unrepairable tool calls produce a clear structured error, never `{}` |
| FR-82 | Needle 3 semantic repair is available, opt-in, and off by default, and is passed the real tool schema |

### 6.9 Helper models

| ID | Requirement |
|---|---|
| FR-90 | Absence of Laya and Needle 3 is detected, logged once, and never fatal |
| FR-91 | When present, Laya (`laya-typed-decisions`) can classify modality, score providers, and validate replies |
| FR-92 | When present, Needle 3 can repair tool calls semantically, do schema-guaranteed extraction, and embed text for retrieval |
| FR-93 | Both are advertised as callable endpoints in `/v1/models` when installed |
| FR-94 | Both are loaded behind an interface with a defined no-op fallback |
| FR-95 | An empty Needle result is a failure, not an empty success |

## 7. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Zero new runtime dependencies beyond what the repo already has. `node:http`, no framework. |
| NFR-2 | Router startup under 2 seconds with a large catalog |
| NFR-3 | Overhead added to a request that passes through the router, excluding upstream time, under 50ms |
| NFR-4 | The virtual key is stored hashed |
| NFR-5 | Outbound requests pass through the existing SSRF guard |
| NFR-6 | The router binds 127.0.0.1 unless explicitly told otherwise; broadcast is opt-in and warned about |
| NFR-7 | Every response is a valid, complete response in its dialect — never a partial SSE stream |
| NFR-8 | All 1137 existing tests continue to pass unchanged |

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic streaming translation is subtle and Claude Code is strict about it | High | Dedicated phase; test against a recorded real Claude Code transcript; a conformance harness |
| Modality capability flags are declared in the schema but implemented nowhere | High | Phase plans treat audio/video as greenfield; discovery must populate real values or leave them null |
| Long generation has no uniform provider contract | Medium | Async job layer absorbs it; capability-driven, and an unsupported pair is a clear error |
| Small helper models mis-fire | Low-Medium | Off by default; Needle 3 has an empty-list-on-nothing-fits behaviour and a schema-compiled grammar; every use is observable and thresholded |
| Key rotation storms under retry | Medium | Sticky pointer converges after one attempt; budgets trip before providers do |
| A provider's error taxonomy is subtly different from the mapped one | Medium | The existing mapping is measurement-backed; extend per provider with a recorded probe, not a guess |
| The virtual key ends up in a shell history or log | Low | Redaction in all logging; the key is hashed at rest |

---

## 7a. One correction of record

The original request described "needle llm agentic model (Tiny Function-Calling AI)" and "laya
(open source jev)". An earlier draft of this document recorded both as misidentifications. That
was wrong in one direction and half-right in the other, and the correction is recorded here
because it changes R6 and R8.

Verified with a Hugging Face token against the HF API:

- **`Cactus-Compute/needle3` is a real, purpose-built function-calling model** — Apache-2.0, 121M
  parameters, ~90k downloads. The user's description was accurate. The earlier draft was misled by
  a search result pointing at `NeedleAI/NeedleLLM-0.5B`, **which does not exist** (org 404, repo
  not found). The user was right and the draft was wrong.
- **Laya is a successor to TypeSafe Jev**, not "Jev" itself, and the user's phrasing was
  essentially correct. The earlier draft was right that it is non-generative and wrong to have
  implied that was a defect rather than a fit for classification.

**The net effect on the requirements:** FR-82 and FR-92 now name Needle 3 specifically rather than
"a small model", because its schema-compiled grammar and empty-list-on-nothing-fits behaviour make
it safe to place on the request path, which a general-purpose 0.5B model would not be.
