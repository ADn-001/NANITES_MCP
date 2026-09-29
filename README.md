# Nanites

**Two tools in one repo. Use either, both, or neither.**

| | What it is | Needs a coding harness? |
|---|---|---|
| **`nanites`** | An MCP server that lets Claude Code / Claude Desktop delegate bounded, disposable work to your own local models — so you stop paying frontier tokens for grunt work. | Yes, to be *driven*. |
| **`nanites-router`** | An OpenAI- and Anthropic-compatible HTTP gateway that fronts your cloud provider keys behind one virtual key. | **No.** It stands alone. |

Nanites is the delegation layer, not the orchestrator. Claude Code/Desktop stays your
orchestrator on a paid frontier model and handles anything requiring real judgment.
Nanites hands the cheap, bounded, throwaway work — scanning a codebase, summarizing a
file, drafting a test, answering a side question — to a local LM Studio model or a
cheap cloud model, and returns the result.

The **router** is a separate program with a separate job: it puts your Cloudflare /
OpenRouter / OmniRoute / NVIDIA keys behind one endpoint, adds a virtual key, model
aliasing, key failover, async jobs, and an OpenAI/Anthropic-compatible API. Any client
that speaks those APIs can use it — including things that are not a coding harness at
all. It does not import the MCP server and does not need LM Studio.

Both ship from one repo and share one database, so a key you add once is visible to
both.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [Requirements](#requirements)
- [Install](#install)
- [The router](#the-router)
  - [Standalone setup](#standalone-setup-no-harness)
  - [Using it with a harness](#using-it-with-a-harness)
  - [Router endpoints](#router-endpoints)
  - [Local helper models](#local-helper-models-optional)
- [Getting started](#getting-started)
- [How it works](#how-it-works)
- [The dashboard](#the-dashboard)
- [Configuration](#configuration)
- [Tool reference](#tool-reference)
- [Slash commands](#slash-commands)
- [Development](#development)
- [Known limitations](#known-limitations)

---

## Why it exists

Delegating work to a small local model is a good idea. Delegating it *blindly* — without
knowing which model is good at what — is how you end up with worse results and a bigger
bill. Nanites builds the part that is tedious:

- **A model registry.** Each model gets a `performance_score` (1-100), plus rolling
  `avg_load_ms` / `avg_response_ms`, recomputed from your real logged runs. The score is a
  speed/stability signal, not an oracle — the skill teaches Claude to weigh it alongside
  the test-regimen results and your own approvals.
- **A test regimen.** A built-in suite of modular test units runs against a model.
  Deterministic ones (valid JSON, exact label) are scored automatically; the rest come
  back to *you* for judgment — never auto-filed as passing.
- **Guardrail tiers keyed to your VRAM.** A 4 GB card and a 24 GB card get different
  concurrency advice, and the advice comes with a stated reason so Claude can explain it.
- **A cost-saved report.** Every delegation is logged with token counts and a computed
  saving, so the claim is auditable rather than vibes.

## Requirements

| Requirement | Needed for | Notes |
|---|---|---|
| **Node.js 22.5+** | everything | Hard requirement. Nanites uses the built-in `node:sqlite` module, which does not exist on Node 20. |
| **LM Studio** | local models only | Talks to LM Studio's local HTTP server (`http://localhost:1234` by default). **Not needed by the router** — a cloud-only gateway never touches it. |
| **Claude Code or Claude Desktop** | the plugin experience | Any MCP-capable client works for the raw server. **Not needed by the router.** |
| A cloud provider key | cloud routing | Cloudflare / OpenRouter / OmniRoute / NVIDIA / any OpenAI-compatible endpoint. |
| Python + `cactus-needle`, `laya` | local helper models | Optional, and every helper feature defaults off. Without them the router is unaffected. |
| `cloudflared` | the quick tunnel only | Only for `POST /v1/tunnel`. A missing binary is a 501, not a failure. |

> No `lms` CLI is required. Nanites will *try* `lms server start` as a recovery step if
> LM Studio is unreachable, but it is best-effort and non-blocking.

## Install

### As a Claude Code plugin (recommended)

```bash
git clone https://github.com/ADn-001/NANITES_MCP.git
cd NANITES_MCP
npm install
npm run build
```

Point Claude Code at the plugin directory for this session:

```bash
claude --plugin-dir ./plugin/nanites
```

To install it permanently as a marketplace plugin:

```bash
claude plugin marketplace add ADn-001/NANITES_MCP
claude plugin install nanites@nanites
```

`npm run build` also installs the plugin's own runtime dependencies into
`plugin/nanites/node_modules` (the plugin resolves its imports relative to the
plugin root, so it needs its own copy). The two commands above are therefore all
that a fresh clone needs — no separate `npm install` inside the plugin
directory, and no manually copied `dist`.

Build output is not tracked in git. `plugin/nanites/dist` is generated by
`npm run build`, which copies the compiled server there because Claude Code
refuses a plugin path that escapes the plugin directory.

### As a plain MCP server

Register it with any MCP client. For Claude Code, add to your project `.mcp.json`:

```json
{
  "mcpServers": {
    "nanites": {
      "command": "node",
      "args": ["/absolute/path/to/NANITES_MCP/dist/index.js"]
    }
  }
}
```

Run `npm run build` first — `dist/index.js` does not exist until you do.

## The router

`nanites-router` is a standalone HTTP gateway. It presents an OpenAI Chat Completions
and an Anthropic Messages API, and forwards to whichever provider serves the model
you asked for. It is the piece to use if your consumer is **not** Claude Code — a
script, a library, another agent framework, a spreadsheet macro, anything that can
POST JSON.

It does not import the MCP server, does not construct an MCP server, does not touch
the LM Studio lifecycle, and never asks a harness what to do. On a machine that has
never seen Claude Code it runs exactly the same.

### What it adds over calling a provider directly

- **One key instead of yours in every client.** The router generates a virtual API
  key, stored scrypt-hashed with a per-install salt. Clients authenticate to the
  router; the router authenticates to the provider.
- **Model aliasing.** Publish a model under a name a harness will accept
  (`nanites-flash`) and map it to whatever the provider actually calls it. Clients
  never see a slash-and-colon id.
- **Ordered failover chains.** An alias can list candidates; the router tries them
  in order and remembers the winner. It absorbs "unavailable right now" and
  propagates real errors — a provider that 500s on everything is not walked past
  four times just to return the same error.
- **Key failover, scoped to the provider.** Round-robin, random, most-used, or
  sticky-last-best across your keys. A different provider is never silently
  substituted — that is a different model at a different price.
- **Async jobs.** `POST /v1/jobs` runs a slow generation (an image, a video, TTS)
  and gives you a job id, an SSE progress stream, and cancellation. Retry with
  backoff on transient upstream failures; a shape rejection is never retried.
- **Rate limiting and a quick tunnel.** Token-bucket limiting per virtual key, and
  `POST /v1/tunnel` to expose it through a cloudflared quick tunnel for testing.

### Standalone setup (no harness)

```bash
git clone https://github.com/ADn-001/NANITES_MCP.git
cd NANITES_MCP
npm install
npm run build

# 1. Create a profile and make it active. This is the ACTIVE profile the
#    router reads, and it is the same profile the Providers tab writes.
nanites-cli init

# 2. Add a key. Read it from the environment so the secret never lands in
#    shell history or in another process's argv.
export NANITES_API_KEY_CLOUDFLARE=...
nanites-cli add-key cloudflare --account-id <your-account-id> --nickname work

# 3. List the provider's catalog.
nanites-cli discover cloudflare

# 4. Check what is configured before starting anything.
nanites-cli status
```

`nanites-cli` never prompts — a blocking prompt cannot be scripted, and an EOF on a
pipe looks like an empty key. Missing input is an error naming the flag that fixes it.
It is idempotent, and it never prints a secret.

Discovery stores **candidates**. Registering one is a separate, deliberate act, and
`status` reports both counts, because "65 discovered, 0 registered" is a normal
starting state and not a failure.

Then start it:

```bash
NANITES_ROUTER_KEY=choose-your-own-virtual-key nanites-router
# nanites-router listening on http://127.0.0.1:4800
```

Set `NANITES_ROUTER_KEY` and the router uses your key. Leave it unset and the router
generates one and prints it **once** — stdout is not a secret store, so it is never
re-printed.

```bash
curl http://127.0.0.1:4800/v1/chat/completions \
  -H "Authorization: Bearer $NANITES_ROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"cloudflare:@cf/meta/llama-4-scout-17b-16e-instruct",
       "messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```

Both dialects work. An Anthropic client sets `anthropic-version: 2023-06-01` and
uses `/v1/messages`.

> **The router and the Providers tab share one key store.** Add a key in the
> Providers tab, or with `nanites-cli add-key`, and the router can use it on its
> next request — no restart, and no second place to enter it. Switching your active
> profile changes which keys the router uses.

### Using it with a harness

Nothing changes. The router reads the same database, so keys added through the MCP
Providers tab or the dashboard are already there. To let a client reach the router
over a network rather than loopback, `POST /v1/tunnel`:

```bash
curl -X POST http://127.0.0.1:4800/v1/tunnel -H "Authorization: Bearer $NANITES_ROUTER_KEY"
```

It prints a `trycloudflare.com` URL. That is a **public** endpoint with real provider
spend behind it and the virtual key as the only thing in between — the router says so
at startup when it is not bound to loopback, and it says so again here.

### Router endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | bind, port, key presence, provider/key counts, helper status |
| `GET` | `/v1/models` | the advertised catalog. Anthropic-shaped when `anthropic-version` is sent, OpenAI-shaped otherwise |
| `GET` | `/v1/keys` | key inventory per provider |
| `POST` | `/v1/messages` | Anthropic Messages, non-streaming or SSE |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions, non-streaming or SSE |
| `POST` | `/v1/jobs` | start an async generation; returns a job id |
| `GET` | `/v1/jobs/:id` | job status, phase, and artifact |
| `GET` | `/v1/jobs/:id/events` | SSE progress |
| `DELETE` | `/v1/jobs/:id` | cancel |
| `GET`/`PATCH` | `/v1/config` | read and change writable feature flags |
| `POST` | `/v1/helpers/{extract,classify,embed,score}` | direct helper calls, when enabled |
| `POST` | `/v1/tunnel` | start a cloudflared quick tunnel |

All of them require `Authorization: Bearer <virtual key>`. Rate limits answer `429`
with `retry-after`.

**Modality.** Cloudflare models outside the text-generation category are routed to
Workers AI's `/ai/run` endpoint rather than the chat shim, so image generation, TTS,
and vision models work through the same `/v1/chat/completions` call. An image reply
comes back as `data[0].b64_json`, the shape an image client expects.

### Local helper models (optional)

Two on-device models can sit **inside** the request path. They are free, run
locally, and send nothing anywhere — but they load a model into memory, so **every
one of them defaults to off.**

| Feature | Model | What it does | Measured |
|---|---|---|---|
| `tool_repair` | Needle 3 | reconstructs a mangled tool call after the deterministic repair ladder fails | 7/7 exact, 1/1 correct abstention |
| `structured_output` | Needle 3 | extracts a `response_format` schema from free text | 4/4 exact |
| `laya_preflight` | Laya | batched routing / moderation questions | **weak** — 40% on a 20-case set |
| `laya_postflight` | Laya | judges whether a reply refused or hedged | **weak** — 35% zero-shot |

The numbers come from a labeled eval run against the real packages, and the two
`laya_*` rows are why they default off: a classifier that fires on 12 of 20 benign
requests teaches you to ignore it.

```bash
curl -X PATCH http://127.0.0.1:4800/v1/config \
  -H "Authorization: Bearer $NANITES_ROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{"enable_helpers":true,"feature_tool_repair":true}'
```

Turning `enable_helpers` false stops any request from using them **and** kills the
resident workers, so the model is released rather than merely unused. You can also do
this from the dashboard's Router tab, the `/nanites-helpers` command, or the
`nanites_toggleHelpers` MCP tool — all four write the same row.

The helpers need Python with the `cactus-needle` and `laya` packages. Without them
the router is unaffected; they report as unavailable with a reason.

## Getting started

### With a coding harness

Everything below assumes Claude Code (or another MCP client) is driving.

### 1. Create a profile

A profile describes *your machine* — its VRAM, the LM Studio endpoint, pricing, and what
you want to delegate. This is what makes the guardrail and scoring advice specific.

In Claude Code, say something like:

> Create a Nanites profile called `workstation` with 24 GB VRAM and 32 GB RAM, pointing at
> my LM Studio at http://localhost:1234.

Or call the tool directly: `create_profile` with a name, optional `machine_specs`, and an
optional `endpoint`. If you omit `machine_specs`, a conservative baseline is used
(4 GB VRAM — the safe default that keeps you sequential).

### 2. Point it at your endpoint

If your LM Studio requires an API token, set it on the profile (`endpoint.auth_token`),
or export `NANITES_LMS_API_TOKEN` to cover profiles that leave it null. If LM Studio is
down when you start, run `system_health_check` — it attempts a one-shot `lms server start`
and rechecks before reporting `down`.

### 3. Load a model and delegate something small

> What models do I have? → `list_models`
> Load the small coding model. → `load_model`
> Summarize what this repo's build script does. → `run_sub_agent`

The first `run_sub_agent` is where the machinery engages: the model is hot-loaded if
needed, the inference gate serializes access for your profile's tier, the reply passes
through the cleaner (strips reasoning tags, catches degeneration loops), and the run is
logged so the score can be recomputed next time.

### 4. Build up the registry

Once you have a few models:

- `run_test_regimen` — score a model against the built-in units
- `get_pending_judgments` — pull back the units that need your call
- `submit_test_judgment` — record your score and approve it
- `write_registry_entry` — persist a model and its parameters

After that, `run_sub_agent` picks better models automatically because the registry knows
what each one is actually good at.

### 5. Check what you saved

> How much have I saved? → `get_cost_saved_report`

Reads real logged token counts and computes the not-spent cost at your profile's rates.

## How it works

**Transport.** stdio. The MCP server is a child process; Claude Code owns the pipe.

**Storage.** Everything lives under `NANITES_HOME` (default `~/.nanites`):
- `profiles/*.json` — small, human-editable, rarely written
- `nanites.db` — SQLite (WAL mode) for the registry, call logs, events, test results

**Concurrency.** Your profile's VRAM determines a guardrail tier, which determines a
`(max_parallel_models × num_parallel)` pair. Forced-sequential tiers (< 12 GB) also route
through a per-profile **inference gate** — one in-flight inference at a time — so
overlapping sub-agents queue instead of fighting over a single model slot.

**Providers.** Local LM Studio, or cloud (Cloudflare Workers AI / OpenRouter / OmniRoute /
any OpenAI-compatible endpoint). Cloud runs get a sandboxed filesystem tool loop that
Nanites executes in-process, confined to a configured root.

**Sanitization.** Anything returned to the orchestrator is scrubbed: no reasoning-tag
leakage, no absolute filesystem paths, no usernames, no raw upstream error bodies. Loop
detection in generated text cuts the degenerate tail and flags it rather than silently
shipping it.

## The dashboard

A local web dashboard runs as a *separate* process sharing the same database.

```bash
npm run ui      # http://127.0.0.1:4700
```

Views: Live Execution, Registry & Leaderboards, Hardware State, Cost & Ledger, System
Health, Providers, **Router**, Settings, Errors. Live sub-agent output streams in over
SSE by polling the events table — no cross-process IPC.

The **Providers** tab is where you add and enable provider keys. The **Router** tab
shows what the gateway is configured with (bind, port, key presence, per-provider key
counts, job totals) and holds the helper-model toggles. Both read the same database, so
they cannot disagree — and a key you add in Providers is usable by the router on its
next request. The dashboard never shows the virtual key or a provider key, only
whether one is set.

### Themes

Three switchable profiles, set in Settings and stored on the active profile:

| Theme | Character |
|---|---|
| **Retro Instrument** (default) | E-ink paper-and-ink with a single orange signal, hard 1px borders, corner brackets, a faint dither texture, and a day/night toggle. System monospace only. |
| **Phosphor Terminal** | Green CRT, angular and gritty, with the cursor-evading skull in the header. |
| **Modern Minimal** | Clean dark, quiet typography, sans headings. |

The dashboard binds `127.0.0.1` by default. A Broadcast setting can expose it on the LAN
for a phone or tablet; that mode is **read-only** unless the caller presents the
per-boot LAN token (sent as `X-Nanites-Lan-Token`), and Broadcast warns before enabling
because it exposes local data to the network.

## Configuration

Everything is environment variables — **there is no `.env` loader.** Export them into your
shell (or your MCP server's `env` block) before starting.

| Variable | Purpose | Default |
|---|---|---|
| `NANITES_HOME` | Storage root | `~/.nanites` |
| `NANITES_UI_PORT` | Dashboard port | `4700` |
| `NANITES_LMS_API_TOKEN` | LM Studio auth token (used when the profile has none) | — |
| `NANITES_LMSTUDIO_MODELS_DIR` | Where to measure free disk for downloads | `~/.lmstudio/models` |
| `NANITES_VISION_ROOTS` | Allowed roots for image paths (`;`-separated) | current directory |
| `NANITES_AUTOSTART_UI` | Set `0` to disable dashboard orchestration | `1` |
| `NANITES_HF_FETCH` | Set `1` to allow Hugging Face network lookups | off |

## Tool reference

Nanites exposes the real 55-tool surface, grouped by what you would use it for:

**Models and inference** — `list_models`, `get_loaded_model`, `load_model`, `unload_model`,
`chat`, `download_model`, `get_download_status`, `download_and_wait`, `download_and_test`

**Delegation** — `run_sub_agent`, `start_sub_agent_job`, `get_sub_agent_job_status`,
`start_btw_chat`, `share_test_results`, `get_cost_saved_report`

**Registry** — `read_registry`, `write_registry_entry`, `diff_untested`,
`run_untested_sweep`, `filter_by_guardrail`, `seed_provider_models`, `set_role_pin`,
`list_role_pins`, `delete_role_pin`

**Profiles** — `create_profile`, `switch_profile`, `update_profile`, `list_profiles`,
`get_active_profile`, `get_first_run_status`

**Testing and scoring** — `list_test_units`, `validate_test_unit`, `register_test_unit`,
`run_test_regimen`, `get_pending_judgments`, `submit_test_judgment`, `check_adaptation`,
`register_adapted_units`

**Cloud providers** — `nanites_addProviderKey`, `nanites_removeProviderKey`,
`nanites_listProviderKeys`, `nanites_toggleProviderKey`, `nanites_discoverProviderModels`,
`nanites_listProviderModels`, `nanites_registerProviderModel`,
`nanites_deregisterProviderModel`, `nanites_showProviderErrors`,
`nanites_setProviderEnabled`, `nanites_getProviderConfig`,
`nanites_setProviderPreferenceOrder`

**Health and notifications** — `system_health_check`, `send_ntfy`

Every tool takes schema-validated input and returns a structured envelope —
`{code, message, retryable, details?}` — never a raw throw or stack trace.

## Slash commands

Available once the plugin is loaded:

`/nanites-new-profile`, `/nanites-switch-profile`, `/nanites-profiles`,
`/nanites-models`, `/nanites-registry`, `/nanites-untested`, `/nanites-cost-saved`,
`/nanites-effort`, `/nanites-dynamic-model`, `/nanites-pin`, `/nanites-vision`,
`/nanites-seed-agents`, `/nanites-health`, `/nanites-btw`,
`/nanites-helpers`

`/nanites-btw` opens a side-conversation with a model mid-task — useful when you want to
ask "wait, what does that function do?" without derailing the main thread.

## Development

```bash
npm install
npm run build        # tsc + copy frontend to dist/ui, skill, and plugin server bundle
npm test             # full suite, mocked — no LM Studio or network required
npm run typecheck    # tsc --noEmit
```

The test suite is fully self-contained: 162 test files run against a mock LM Studio
server and a scratch `NANITES_HOME`, so nothing touches your real data or the network.
CI runs typecheck + tests on every push.

Optional live checks (require a running LM Studio with a model loaded):

```bash
npm run live-smoke
npm run live-feature
```

## Known limitations

- **Node 22.5+ is required.** This is a hard floor imposed by `node:sqlite`, not a
  preference. Node 20 will not run it.
- **There is no `.env` loader.** If you rely on a `.env` file in your current workflow,
  you will need to export variables into the environment instead.
- **The cloud filesystem grant executes real writes** when a profile enables it. It is
  confined to a configured root and `write_file` requires explicit opt-in, but it is a
  real capability, not a simulation.
- **`command-runner` integration carries a shell grant.** Keep `tools.enabled: false`
  unless a profile genuinely needs it.
- **Provider API keys are stored in plaintext** in `nanites.db`. The file is created with
  `0600` permissions where the OS supports it, but this is not encrypted at rest.
- **The dashboard's Broadcast mode exposes local data to the LAN.** It is read-only
  without a token, but the token is printed to the console at startup.
- **`live-smoke` timing is sensitive to LM Studio contention.** A loaded machine can
  exceed the script's budget even when everything is working.
- **The router reads the ACTIVE profile's provider keys.** This is what makes one
  key store work across the CLI, the Providers tab, and the gateway — but it also
  means switching your active profile changes which keys the router uses. The
  "router config is global" property holds for the router's own tables (config, key
  metrics, aliases, the advertised catalog, jobs) and deliberately not for provider
  keys.
- **The router does not create a profile for you.** `nanites-cli init` does, but a
  router started on a home with no active profile refuses every request rather than
  guessing which provider you meant. That refusal is deliberate.
- **The two `laya_*` helper features are not reliable.** Measured zero-shot on a
  20-case labeled set: 40% on cache-poisoning, 35% on refusal detection, and 90% on
  modality intent against a deterministic heuristic that is already 100%. They are
  exposed for inspection and would need fine-tuning and calibration on your own
  labelled router traffic before they should gate anything. That is why they default
  off; `tool_repair` and `structured_output` are measured strong and are the ones
  worth enabling.
- **Cloudflare's own quotas still apply.** A key whose daily free allocation is spent
  is retired until the next UTC midnight. The router rotates the rest of the pool and
  tells you which key failed and why — it cannot create neurons.

## License

[MIT](LICENSE) © 2026 Adnan Shelim. Use it, fork it, ship it commercially.

## Acknowledgements

Built against the [LM Studio REST API](https://lmstudio.ai/docs/app/api) and the
[Model Context Protocol](https://modelcontextprotocol.io) TypeScript SDK.
