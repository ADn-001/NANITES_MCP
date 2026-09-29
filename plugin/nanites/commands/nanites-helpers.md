---
description: Turn the router's local helper models (Needle 3, Laya) on or off, per feature
argument-hint: "[on|off|<feature> on|<feature> off]"
---

Toggle the router's optional local helper models.

Helpers run **on-device** — no cloud key, no per-token cost, no data leaving the
machine — but they do load a model into memory. Everything here defaults to
**off**, and turning them off means no request will use them.

Features, with the measured evidence behind each:

| feature | helper | what it does | measured |
|---|---|---|---|
| `tool_repair` | Needle 3 | reconstructs a mangled tool call after the deterministic ladder fails | 7/7 exact, 1/1 correct abstain |
| `structured_output` | Needle 3 | extracts a `response_format` schema from free text | 4/4 exact |
| `laya_preflight` | Laya | batched routing / moderation questions | **weak** — 40% cache-poisoning, 90% modality vs a 100% deterministic baseline |
| `laya_postflight` | Laya | "did the model refuse or hedge?" | **weak** — 35% zero-shot |

The two `laya_*` features are exposed but not recommended: those numbers are
below the threshold where a classifier earns an operator's trust, and a guard
that fires on 12 of 20 benign requests trains people to ignore it.

## Usage

- `/nanites-helpers` — report current state, with the evidence
- `/nanites-helpers on` / `off` — flip the master switch
- `/nanites-helpers tool_repair on` — change one feature, leave the rest alone

## Steps

1. Call `nanites_readHelperState` on the Nanites MCP server.
2. Determine the change from the argument:
   - no argument: report state and stop.
   - `on` / `off`: call `nanites_toggleHelpers` with `{enable: true|false}`.
   - `<feature> on|off`: call `nanites_toggleHelpers` with
     `{features: {"<feature>": true|false}}` — a partial map, so the other
     features are untouched.
   - Anything unrecognised as a feature name: say so and list the valid names
     rather than guessing. An unknown name is rejected by the tool.
3. Call `nanites_readHelperState` again and report the confirmed state.

If the tool reports `workers_stopped: false`, say so plainly: no request will
use the helpers, but the **running router process still holds the loaded model
in memory** until it restarts, or until
`PATCH /v1/config {"enable_helpers": false}` is sent to the live router (which
is the one path that can stop a resident worker). Do not report a clean stop
that did not happen.
