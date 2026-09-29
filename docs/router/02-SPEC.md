# nanites-router — Technical Specification

**Status:** locked, pre-implementation
**Companion to:** [`00-DESIGN.md`](00-DESIGN.md), [`01-PRD.md`](01-PRD.md)

This document specifies the interfaces and data shapes that the phase plans implement. Where a
shape is marked **existing**, it already lives in the repo and is referenced, not redesigned.

---

## 1. Process and packaging

**New bin, same package.**

```json
// package.json — addition
"bin": {
  "nanites": "./dist/index.js",
  "nanites-router": "./dist/router/main.js"
}
"scripts": {
  "router": "node dist/router/main.js",
  "router:dev": "tsx watch src/router/main.ts"
}
```

`src/router/main.ts` is a standalone process. It does not import the MCP server, does not
register tools, and does not require a Claude harness (FR-63). It shares `src/storage/` and
`src/providers/`.

**Environment**

| Var | Default | Meaning |
|---|---|---|
| `NANITES_HOME` | `~/.nanites` | Shared with the MCP server — the point of D1 |
| `NANITES_ROUTER_PORT` | `4800` | Listening port |
| `NANITES_ROUTER_BIND` | `127.0.0.1` | Bind address; `0.0.0.0` only when explicitly set |
| `NANITES_ROUTER_KEY` | — | User-set virtual key; auto-generated if absent |
| `NANITES_ROUTER_TUNNEL` | `0` | `1` starts a cloudflared quick tunnel on boot |

No `.env` loader. The repo has none today and this does not introduce one (existing decision).

## 2. Internal representation

The IR is the pivot of the whole design. Inbound decoders produce it; outbound encoders consume
it. Neither dialect's shape leaks past its own module.

```ts
// src/router/ir/types.ts
export type Modality = "text" | "audio" | "image" | "video";

export type IRContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; url: string; mime?: string }
  | { type: "input_audio"; data: string; mime: string }   // base64
  | { type: "video_url"; url: string; mime?: string };

export interface IRMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | IRContentPart[];
  /** Anthropic thinking blocks, preserved for round-trip. Empty on the OpenAI side. */
  thinking?: IRThinkingBlock[];
  /** Present on role:"tool". */
  tool_call_id?: string;
  /** Present on role:"assistant". */
  tool_calls?: IRToolCall[];
  name?: string;
}

export interface IRThinkingBlock { type: "thinking"; thinking: string; signature?: string }

export interface IRToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;   // parsed object, never a string
}

export interface IRToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;   // JSON Schema, Anthropic's name; OpenAI calls it "parameters"
}

export type IRStopReason =
  | "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "error";

export interface IRRequest {
  model: string;                 // alias or namespaced id, as the caller sent it
  messages: IRMessage[];
  system?: string;
  tools?: IRToolDef[];
  max_output_tokens: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  stop?: string[];
  /** Modality requested by the caller; when absent the router classifies it. */
  output_modality?: Modality;
}

export interface IRResponse {
  model: string;
  content: IRContentPart[];
  thinking: IRThinkingBlock[];
  tool_calls: IRToolCall[];
  stop_reason: IRStopReason;
  usage: { input_tokens: number; output_tokens: number; reasoning_tokens?: number };
  latency_ms: number;
  /** Which upstream actually served it. */
  served_by: { provider: string; model_id: string; key_id: string };
}
```

The `arguments: Record<string, unknown>` type is the load-bearing choice: the IR can never
represent the `arguments: "{}"` state that `parseToolCalls` currently produces.

## 3. Inbound surface

### 3.1 Routes

```
POST   /v1/messages                     Anthropic Messages
POST   /v1/chat/completions             OpenAI Chat Completions
GET    /v1/models                       advertised catalog (dialect-neutral + both renderings)
GET    /v1/models/:id                   single advertised model
POST   /v1/jobs                         submit a generation job
GET    /v1/jobs/:id                     job status + artifact
GET    /v1/jobs/:id/events              SSE progress
DELETE /v1/jobs/:id                     cancel
GET    /v1/health                       router + per-provider health
GET    /v1/keys                         aggregate key health (no secrets)
```

### 3.2 Auth

```ts
// src/router/auth.ts
export function verifyVirtualKey(req: IncomingMessage, expected: string): boolean
export function hashVirtualKey(key: string): string   // scrypt, per-install salt
```

Constant-time comparison, reusing the existing `tokensMatch` in `src/ui/guards.ts`. The stored
form is the hash (NFR-4). Startup: if `NANITES_ROUTER_KEY` is set, use it; otherwise read
`router_config.virtual_key_hash`, or generate and persist one, printing it once to stdout.

An unauthenticated request returns `401` with the dialect's native error shape, not a generic
one — an OpenAI client expects `{"error":{"message","type","code"}}` and an Anthropic client
expects `{"type":"error","error":{"type","message"}}`.

### 3.3 Anthropic Messages decoding

Required mappings into the IR:

| Anthropic | IR |
|---|---|
| `system` (string or block array) | `system` (concatenated text) |
| `content` block array | `IRContentPart[]` |
| `{type:"text",text}` | `{type:"text",text}` |
| `{type:"image",source:{type:"base64",media_type,data}}` | `{type:"image_url",url:"data:…"}` |
| `{type:"thinking",thinking,signature}` | `IRThinkingBlock` |
| `tools[].input_schema` | `IRToolDef.input_schema` |
| `tool_use` block | `IRToolCall` |
| `tool_result` block | `{role:"tool", tool_call_id, content}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |
| `stream` | `stream` |

### 3.4 Anthropic Messages streaming

The strict part. Required event sequence, in order, with correct indices:

```
message_start        {type, message:{id,type,role,model,content:[],stop_reason:null,usage:{input_tokens,output_tokens:0}}}
content_block_start  {index, content_block:{type:"text",text:""}}         (or thinking / tool_use)
content_block_delta  {index, delta:{type:"text_delta",text}}             (or input_json_delta / thinking_delta)
content_block_stop   {index}
message_delta        {delta:{stop_reason, stop_sequence}, usage:{output_tokens}}
message_stop
```

Rules:
- Every `content_block_start` has a matching `content_block_stop`.
- A tool call streams as one `tool_use` block with `input_json_delta` partial-JSON fragments.
  The router must **not** parse the fragments into a completed object until the block closes —
  the existing repair ladder (FR-80) runs on the assembled string at `content_block_stop`.
- `ping` events are emitted at least every 30 seconds on long generations to keep intermediaries
  from closing the connection.
- The final `message_delta` carries the real cumulative `output_tokens`.
- On any error mid-stream, a `message_stop` is still emitted so the client is not left hanging.

### 3.5 OpenAI Chat Completions

`content` may be a string or a part array; the part array gains `input_audio` for the audio leg
and an OpenRouter-compatible video part. `tools[].function.parameters` maps to
`IRToolDef.input_schema`. `finish_reason` maps to `IRStopReason`. Streaming is
`chat.completion.chunk` frames ending with `data: [DONE]`.

## 4. Outbound surface

### 4.1 Reuse

Every outbound call goes through the **existing** `ProviderClient` interface
(`src/providers/client.ts:31-44`) via `chatWithBudgetRetry` (`src/providers/cloudPlanner.ts:215`),
so budget retry, empty-reply detection, cost computation, and the wire-model-id strip are
inherited unchanged.

The router's outbound layer is a thin adapter:

```ts
// src/router/outbound/dispatch.ts
export interface DispatchInput {
  db: DatabaseSync;
  profileName: string;          // the router's own global pseudo-profile
  provider: ProviderKind;
  model: IRRequest;
  endpoint?: string;            // generic endpoints scope the key pool
}
export async function dispatch(input: DispatchInput): Promise<IRResponse>
```

It translates `IRRequest` → `ChatRequest`, calls `chatWithBudgetRetry`, and translates the
`ChatResponse` back. It does not re-implement retry, key selection, or error classification.

### 4.2 Provider kinds

`nvidia` is added as a fifth `ProviderKind`:

```ts
// src/providers/types.ts — addition
export type ProviderKind = "local" | "cloudflare" | "openrouter" | "omniroute" | "generic" | "nvidia";
```

`NvidiaClient` mirrors `OpenRouterClient` exactly — same base URL shape, same bearer auth, same
`/models` and `/chat/completions` paths, default `https://integrate.api.nvidia.com/v1` — and adds
no reasoning-field special-casing, because NIM accepts plain OpenAI params. Account id is not
used; it is accepted and ignored so a config that carries one does not fail validation.

Cloudflare's account id stays in the URL path
(`/client/v4/accounts/{account_id}/ai/v1/chat/completions`) while the token is the bearer —
this is why `mapFetchError` strips the URL from error messages (`src/providers/errors.ts:123-124`),
and the router must preserve that.

### 4.3 The global pseudo-profile

Router config is global (D3), but the existing stores are all `profile_name`-scoped. The router
uses the reserved name `"__router__"` in every store call, so no store changes and no collision
with a real profile is possible.

```ts
export const ROUTER_PROFILE = "__router__";
```

`create_profile` must reject this name, or the reservation is not a reservation.

## 5. Key selection

```ts
// src/router/keys/selector.ts
export type KeyStrategy = "random" | "round_robin" | "usage_failover" | "sticky_last_best";

export interface KeyCandidate {
  key_id: string;
  provider: string;
  nickname: string | null;
  gateway_url: string | null;
  /** 0..1; higher is better. Defaults to 1. Only used by usage_failover. */
  usage_ratio: number;
  is_sticky: boolean;
  consecutive_failures: number;
}

export interface SelectionPolicy {
  strategy: KeyStrategy;
  /** usage_failover only: 0..1 of the monthly budget that trips exhaustion. */
  budget_threshold: number;
  /** Sticky lifetime in turns. */
  sticky_ttl_turns: number;
  /** Fallback when the strategy has no preference. */
  fallback: "random" | "round_robin";
}

export function selectKey(candidates: KeyCandidate[], policy: SelectionPolicy, now: Date): KeyCandidate | null
```

`usage_failover` returns the *most* used key under budget — which, given the budget trips at the
threshold and the key is then excluded, is the "keep using one until it is done" behaviour. It
does not spread load, and that is intended: it is for providers with per-account quotas where
spreading is worse than saturating one account.

`sticky_last_best` checks `router_sticky` for the model first, and if that key is still a valid
candidate returns it. Otherwise it delegates to `fallback`. Every success writes the sticky row;
`consecutive_failures > 0` or a retirement deletes it.

Reuse: exhaustion, the round-robin cursor, and the 3-failures/5-minutes rule all stay in
`ProviderKeyStore` (existing) rather than being reimplemented.

## 6. Aliases and chains

```ts
// src/router/models/aliases.ts
export interface ChainCandidate {
  provider: string;
  endpoint?: string;
  model_id: string;
  /** Optional per-candidate override of the caller's params. */
  max_output_tokens?: number;
  temperature?: number;
}

export interface AliasDef {
  alias: string;
  candidates: ChainCandidate[];   // ordered; index 0 is tried first
  sticky_winner: number | null;   // index of the last successful candidate
  created_at: string;
}

export function resolveChain(alias: string, db: DatabaseSync): AliasDef | null
export function walkChain(alias: AliasDef, send: (c: ChainCandidate) => Promise<IRResponse>): Promise<IRResponse>
```

`walkChain` semantics (D7):

1. Start at `sticky_winner` if set and still valid, else 0.
2. Try the candidate. A **real answer** means non-empty content or a non-empty tool call — the
   same emptiness test `isEmptyCloudReply` already applies (`src/providers/cloudPlanner.ts:197`).
3. On success: record the winner, return.
4. On a key-scoped or model-scoped failure: try the next candidate. These are the failures a
   chain exists to absorb.
5. On any other failure: propagate. A chain is not a general error sink; a 500 that would fail
   everywhere should fail visibly.
6. Exhausted: `chain_exhausted`, naming the alias and every failure.

Write-time validation: every candidate must resolve to a row in `provider_models`. A dangling
reference is `alias_candidate_unknown`.

## 7. Advertised catalog

```ts
// src/router/models/catalog.ts
export interface AdvertisedModel {
  id: string;              // the harness-safe alias
  real_id: string;         // provider[:endpoint]:model_id
  provider: string;
  modalities: Modality[];
  context_window: number | null;
  created_at: string;
}
```

`GET /v1/models` returns only advertised entries, rendered in both dialects:

```jsonc
// OpenAI rendering
{ "object": "list", "data": [ { "id": "nanites-flash", "object": "model",
  "created": 0, "owned_by": "nanites-router", "context_length": 131072,
  "capabilities": { "modalities": ["text"], "function_calling": true } } ] }
```

```jsonc
// Anthropic rendering (same request, dialect header decides)
{ "data": [ { "type": "model", "id": "nanites-flash", "display_name": "nanites-flash",
  "created_at": "2026-09-29T00:00:00Z" } ], "has_more": false, "first_id": "nanites-flash",
  "last_id": "nanites-pro" }
```

The dialect is chosen by the `anthropic-version` header when present, else OpenAI. This is what
makes the alias necessary: a client that only accepts its own nomenclature needs an id it will
accept, and `nanites-flash` is one it will.

## 8. Modality routing

```ts
// src/router/modalities/matrix.ts
export type ModalityLeg = "text" | "audio" | "image" | "video";
export type ConversionLeg = "transcribe" | "caption" | "passthrough" | "generate";

export interface ModalityPlan {
  source: ModalityLeg;
  target: ModalityLeg;
  legs: ConversionLeg[];        // 1 entry = direct, 2 = convert-then-route
  model: string;                // the model serving the FINAL hop
  pinned: boolean;
}

export function planModality(source, target, capabilities, pins): ModalityPlan | null
```

Decision order:

1. A pin for `(source, target)` exists — use it, `pinned: true`.
2. A model in the advertised catalog natively accepts `source` and emits `target` — direct, one
   leg, and the cheapest path.
3. An `X → text` model exists and the target chain starts at text — transcribe/caption, then
   route. Two legs.
4. Otherwise `null`, and the request fails with `modality_unsupported` naming the pair.

**Capability truth.** `ProviderCapabilities` already declares
`{vision, audio, video, function_calling, reasoning?}` and `provider_models.supported_modalities`
already has a column — but nothing populates audio or video
(`src/storage/providerModelStore.ts:60-65` writes only `["text"]` or `["image","text"]`), and
nothing reads them. Phase plans must treat this as unimplemented. A model whose modality
capability is unknown is **not** a candidate; guessing is what produces silent wrong-route
failures.

**Generation response shapes differ from chat completions.** OpenRouter returns image, audio, and
video through `modalities` on `/api/v1/chat/completions`, and image results are additionally
retrievable by generation id from `GET /api/v1/generation?id=…`. A generation response therefore
cannot be parsed by `parseChatResponse` and needs its own decoder.

**Phase split.** R5a covers classification, capability population, the planner, pins, audio→text,
image→text, and text→image — the legs that are cheap, well-supported, and synchronous. R5b covers
video, long audio, and the async job layer, and **opens with a live probe of the video endpoints**
whose findings decide how much of it gets built. A cell whose probe does not verify stays
`modality_unsupported`; that is a legitimate outcome, and a half-built cell that mis-routes is not.

## 9. Async jobs

```ts
// src/router/jobs/store.ts
export type JobStatus = "queued" | "running" | "finalizing" | "done" | "failed" | "cancelled";

export interface JobRow {
  job_id: string;
  status: JobStatus;
  source: ModalityLeg;
  target: ModalityLeg;
  model: string;
  /** 0..1 when the provider exposes progress, else null. */
  progress: number | null;
  phase: string;               // always present; the honest fallback signal
  artifact_uri: string | null;
  error: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
```

Jobs are rows, not memory (FR-49). On boot, any job left `running` whose provider call is
unverifiable transitions to `failed` with `job_orphaned` — the repo already has this pattern for
downloads.

**Only the slow legs use this.** Text→image completes in seconds and returns inline from R5a; the
job layer exists for text→video and long text→audio, and is not built at all if the R5b probe
finds neither viable.

Progress: emit `phase` transitions always. Emit numeric `progress` only when the provider
supplies it. **Never** synthesize a percentage from elapsed time; a fabricated 80% on a
three-minute video is worse than no number at all.

## 10. Tool-call repair

```ts
// src/router/tools/repair.ts
export type RepairOutcome =
  | { ok: true; args: Record<string, unknown>; method: "direct" | "extracted" | "coerced" | "needle";
      confidence?: number }
  | { ok: false; code: "tool_call_unrepairable"; detail: string };

export function repairToolArguments(raw: string, schema?: Record<string, unknown>): RepairOutcome
```

Ladder, in order, stopping at the first success:

1. **`direct`** — `JSON.parse` as-is.
2. **`extracted`** — scan for balanced `{...}` accounting for string literals and escapes; parse
   the outermost balanced span. Fixes prose-wrapping and leading chatter.
3. **`coerced`** — strip trailing commas, replace Python `None`/`True`/`False` outside strings,
   drop unquoted keys in an object, then parse. Each correction is a pure syntax fix that cannot
   change the meaning of a valid value.
4. **`needle`** — only if `enable_model_repair` is on. Sends the raw text plus the **actual tool
   schema** to Needle 3 (`Cactus-Compute/needle3`, Apache-2.0, 121M), whose byte-level grammar is
   compiled from that schema so the output is guaranteed to parse. A returned **empty
   `function_calls` list is a failure**, not a success — that is how Needle declines, and treating
   it as "no repair needed" would fabricate a result. The adapter's calibrated confidence is
   thresholded by `needle_min_confidence`.

If the repaired object then fails the declared schema, the result is `ok: false`. The current
behaviour — malformed becomes `{}` and the call proceeds — is what FR-81 forbids.

`{}` is legal and must still be allowed when the schema genuinely has no required properties;
the check is against the schema, not against emptiness.

## 11. Helper models

```ts
// src/router/helpers/interface.ts
export interface HelperModel {
  name: string;
  available(): boolean;
  classify(state: string, options: string[]): Promise<{ choice: string; confidence: number }>;
  score(state: string, criteria: string[]): Promise<{ score: number }>;
  retrieve(query: string, corpus: string[]): Promise<{ indices: number[] }>;
  repairToolCall(raw: string, schema: Record<string, unknown>): Promise<RepairOutcome>;
  extract<T>(text: string, schema: Record<string, unknown>): Promise<T | null>;
}
```

One interface, five methods. Three map onto Laya's `choice` / `score` primitives; two map onto
Needle 3's forced-function-call and embedding capabilities.

**`Laya` — `convaiinnovations/laya-typed-decisions`** (Apache-2.0, 421M, non-generative, ~33ms).
The typed-decisions checkpoint, **not** the base one: base scores 0.362 on typed decisions, this
one scores 0.766, above the 0.735 teacher self-agreement ceiling. Served over
`POST /v1/systemone` via `pip install laya`, or loaded in-process.

**`Needle 3` — `Cactus-Compute/needle3`** (Apache-2.0, 121M, ~90k downloads). Distilled from
Gemini 3.1, post-trained on 2B tokens of function-call data. A Laddered Simple Attention Network
whose capacity is a ladder — every depth from 2 to 20 layers is deployable. Serves `repairToolCall`
and `extract` through its forced-call grammar, and `retrieve` through `needle_embed`.

**Both are invoked by subprocess, adding no npm dependency.** Needle ships a sub-1MB engine per
platform (`windows-x86_64/needle.exe` here) invoked as
`needle --model needle3.cact --tools tools.json --prompt "..."` or `--serve`; Laya is reached over
HTTP or loaded in-process. An unreachable engine means "not installed", never an error.

When a helper is absent, `available()` is false and every call site has a defined fallback:

| Call site | With Laya | Without |
|---|---|---|
| Modality classification | calibrated `choice` | deterministic from content parts |
| Provider scoring | calibrated `score` | registry `performance_score`, then name order |
| Reply validation | Laya `choice` over {refusal, tool_call, answer, degenerate} | the existing emptiness + tool-call-leak checks |
| Catalog retrieval | Needle `needle_embed` | a plain relevance scan |
| Tool-call repair | Needle forced call with the real schema | deterministic ladder, then a clean failure |
| Structured extraction | Needle grammar-constrained call | a hand-rolled reader over known columns |

The contract is that **no request ever fails because a helper is missing** (FR-90, G7).

Laya is a Python package (`pip install laya`) exposing `POST /v1/systemone`, and it can also be
loaded in-process. The router shells out to a local HTTP server rather than embedding a Python
runtime, and treats an unreachable server as "not installed".

## 12. Storage

All in the existing `nanites.db`, all prefixed `router_`, all under `profile_name =
"__router__"` for the stores that are profile-scoped.

```sql
-- singleton
CREATE TABLE router_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  virtual_key_hash TEXT NOT NULL,
  key_salt TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 4800,
  bind TEXT NOT NULL DEFAULT '127.0.0.1',
  default_strategy TEXT NOT NULL DEFAULT 'round_robin',
  budget_threshold REAL NOT NULL DEFAULT 0.9,
  sticky_ttl_turns INTEGER NOT NULL DEFAULT 5,
  enable_model_repair INTEGER NOT NULL DEFAULT 0,
  enable_helpers INTEGER NOT NULL DEFAULT 0,
  tunnel_enabled INTEGER NOT NULL DEFAULT 0,
  tunnel_url TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE router_key_metrics (
  provider TEXT NOT NULL, key_id TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  avg_latency_ms REAL,
  last_success_at TEXT, last_failure_at TEXT,
  usage_threshold INTEGER,           -- null = no per-key budget
  PRIMARY KEY (provider, key_id)
);

CREATE TABLE router_aliases (
  alias TEXT PRIMARY KEY,
  candidates TEXT NOT NULL,         -- JSON ChainCandidate[]
  sticky_winner INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE router_advertised (
  alias TEXT PRIMARY KEY,
  real_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  modalities TEXT NOT NULL,         -- JSON Modality[]
  context_window INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE router_modality_pins (
  source TEXT NOT NULL, target TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, target)
);

CREATE TABLE router_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
  model TEXT NOT NULL, progress REAL, phase TEXT NOT NULL,
  artifact_uri TEXT, error TEXT,
  request TEXT NOT NULL,            -- JSON IRRequest, so a restart can resume
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE router_sticky (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL, key_id TEXT NOT NULL,
  turns_left INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

Migration number is assigned at implementation time — the next free integer after the current
head (v24). The order in the migration array matters, as v24 established.

## 13. MCP tools

All under the `nanites_` prefix, matching the existing provider tools. They read and write the
same `router_*` tables the HTTP server does; no HTTP round trip.

| Tool | Input | Purpose |
|---|---|---|
| `nanites_router_config` | `{}` | router status, port, bind, key-present, strategy, tunnel |
| `nanites_router_setConfig` | `{port?, bind?, strategy?, budget_threshold?, sticky_ttl_turns?, enable_model_repair?, enable_helpers?}` | update |
| `nanites_router_listKeys` | `{}` | per-key health, no secrets |
| `nanites_router_ping` | `{provider, key_id?, account_id?}` | reachability + catalog refresh |
| `nanites_router_listModels` | `{advertised_only?}` | the catalog the harness sees |
| `nanites_router_setAlias` | `{alias, candidates[]}` | create or replace a chain |
| `nanites_router_listAliases` | `{}` | chains with their sticky winners |
| `nanites_router_setAdvertised` | `{alias, real_id, modalities?}` | publish a model under a safe name |
| `nanites_router_setModalityPin` | `{source, target, model}` | pin a cell (D14) |
| `nanites_router_listModalityPins` | `{}` | |
| `nanites_router_jobs` | `{job_id?}` | job status, for a long generation in progress |

`nanites_router_setAdvertised` and `nanites_router_listModels` are what let the orchestrator
read the catalog and retarget itself when it is pointed at the router (FR-50, D14).

## 14. Dashboard

A `Router` tab in `frontend/nanites-dashboard.html`, following the Providers tab's structure.
Panels: virtual key (shown once, then hash-only), key-vault health with strategy and per-key
stats, alias chains with drag-to-reorder and sticky-winner indicator, advertised models with
their aliases, modality pins, and a tunnel toggle.

The frontend is one 167KB HTML file. The lessons from the earlier dashboard work apply directly:
edit with `.split().join()` string replacement, never a regex with an optional capture group;
verify brace balance after every stylesheet edit; and screenshot the actual result rather than
reasoning about it.

## 15. Error codes

New codes, following the existing `{code, message, retryable, details}` shape:

| Code | Retryable | Meaning |
|---|---|---|
| `router_unauthorized` | false | missing or wrong virtual key |
| `router_invalid_request` | false | failed dialect decode |
| `chain_exhausted` | true | every candidate in the alias chain failed |
| `alias_unknown` | false | the requested model is neither an alias nor an advertised id |
| `alias_candidate_unknown` | false | a chain referenced a model not in the catalog |
| `modality_unsupported` | false | no model or pin serves this (source, target) pair |
| `provider_key_required` | false | the named provider has no enabled key |
| `job_not_found` | false | unknown job id |
| `job_orphaned` | false | a running job lost its provider call across a restart |
| `tool_call_unrepairable` | false | the repair ladder could not produce a schema-valid call |
| `endpoint_not_configured` | false | existing code; a named generic endpoint has no key |
