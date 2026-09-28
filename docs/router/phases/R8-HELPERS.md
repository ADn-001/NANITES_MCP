# Phase R8 — Helper Models (Optional)

**Goal:** Needle 3 and Laya integrated as opt-in accelerators, and both served as callable
endpoints. **The router must be complete and correct with neither installed** — that is the
constraint this phase is judged against, not a footnote.

**Depends on:** R4 (catalog), R5a (modality classification hook), R6 (Needle adapter).
**Entirely optional. No other phase may depend on it.**

---

## What these models actually are

Both were verified against their sources with a Hugging Face token. The first pass of this design
was written from web-search results and got both identities wrong.

### Needle 3 — `Cactus-Compute/needle3`

Apache-2.0, **121M parameters**, ~90k downloads, from Cactus Compute (needle.ai is their site).
A Laddered Simple Attention Network: Monarch Hadamard MLP in place of the FFN, GQA attention with
causal conv taps, engram n-gram memory, multi-lane hyper-connections. Capacity is a **ladder** —
every depth from 2 to 20 layers is a deployable model, and most parameters sit in the engram, so
the 121M model does the arithmetic of a 50M one. Weights are CQ2-bit compressed at roughly 2.125
bits per weight; the whole model is one 8-29 MB file. Distilled from Gemini 3.1, post-trained on 2B
tokens of function-call data. It also carries a **calibrated confidence score** from a learned
head.

> **A note on the earlier draft.** This design originally recorded Needle as a 0.5B long-context
> retrieval model that could not do tool calls, on the basis of a search result pointing at
> `NeedleAI/NeedleLLM-0.5B`. That org and model **do not exist** — the org returns 404 and the
> model returns `Repository not found` from the HF API. The user was right and that draft was
> wrong. The record is kept because the error is instructive: a plausible-sounding search result
> pointing at a nonexistent repo is indistinguishable from a real one until you hit the API.

Three jobs, all relevant here:

| Job | What it does | Where it lands |
|---|---|---|
| **Tool calls** | Picks the right functions and fills every argument from what was said. Multiple asks give multiple calls in order. No tool covers it → **empty list, not a guess** | R6 rung 4 |
| **Structured extraction** | Declare a shape, get typed fields. A **byte-level grammar compiled from your schemas constrains every token**, so output is guaranteed to parse | R8 here |
| **Text embedding** | Same model returns a sentence vector for local search, match, and route | R8 here |

Its card claims it beats models 10x its size on mobile tool calls and matches 2-3x larger models
on extraction, and that fine-tuning lifts every subnetwork by 18-36 points — from 4 layers up, a
tuned subnetwork passes DeepSeek V4 Flash.

**Deployment needs no Python.** The repo ships a sub-1MB engine per platform, including
`windows-x86_64/needle.exe`, plus C API static libraries, a WASI component, and a browser build.
A `win_amd64` wheel exists for `pip install cactus-needle`, but the router spawns the binary
directly — no embedded Python, no WASM runtime, no new npm dependency.

### Laya — `convaiinnovations/laya-typed-decisions`

Apache-2.0, 421M parameters (395M ModernBERT-large encoder + a 26M decision head),
**non-generative**. Its own card: *"It never generates text, so there is nothing to parse and
nothing to hallucinate."* ~33ms single forward pass. Typed questions defined per request —
`choice`, `score`, `noul` — against arbitrary state, returning calibrated probabilities. Served
over `POST /v1/systemone` via `pip install laya` (0.3.21), or loaded in-process. Laya is a
successor in the same family as **TypeSafe Jev**, and its card benchmarks against "TypeSafe Jev
1.13.0" — which is where the user's "laya (open source jev)" came from, and is essentially right.

**Use `laya-typed-decisions`, not the base checkpoint.** This matters and was nearly missed: the
base English checkpoint scores **0.362** accuracy on typed decisions, while the typed-decisions
checkpoint scores **0.766** — above the 0.735 teacher self-agreement ceiling, and 2.4x better on
Brier score than Jev's published 0.727. The base is a weak zero-shot model and would have quietly
made the router's decisions worse. The `-multilingual` sibling is mmBERT-base, 322M, 1024 ctx,
100+ languages.

---

## What each is good for

| Router job | Needle 3 | Laya (typed-decisions) |
|---|---|---|
| Semantic tool-call repair | **yes** — grammar compiled from the real schema | no — emits no text |
| Schema-guaranteed structured output | **yes** | no |
| Tool selection from a catalogue | **yes** — empty list when nothing fits | partial |
| Text embedding / retrieval | **yes** | no |
| Pick the provider for a request | partial | **yes** — calibrated `choice` |
| Score a key before sending | partial | **yes** — `score` primitive |
| Classify incoming modality | partial | **yes** — `choice` over modality labels |
| Validate a reply (refusal? tool call? garbage?) | partial | **yes** — 33ms, no parse risk |

They barely overlap: Needle is a *generator* on a tight schema, Laya is a *classifier* over
arbitrary state.

---

## Implementation directions

### R8.1 — The interface

`src/router/helpers/interface.ts` per §11 of the spec. One interface, three methods, mapped onto
Needle's generate/embed and Laya's `choice`/`score` primitives.

The contract that matters: **no request ever fails because a helper is missing.** `available()`
returns false, every call site has a defined fallback, and the router's import graph never requires
a helper module to load.

### R8.2 — Needle adapter

The R6 adapter is the substrate; R8 extends it with the other two capabilities.

- **Structured extraction**: declare a shape as a synthetic single tool, hand the messy text as the
  user turn, take the typed fields from the forced call. The grammar guarantees the parse, so this
  is genuinely more reliable than prompting a general model for JSON.
- **Embedding**: `needle_embed` per the project's porting notes. Used for local relevance search
  over the consolidated catalog and over long transcripts.
- **Confidence**: carried through to routing decisions, where it is the signal to threshold on.
- **Layer selection**: the ladder runs 2-20 layers. Expose it; default to the full model. A smaller
  slice is faster and its accuracy on this repo's schemas is measurable.

### R8.3 — Laya adapter

- Detection: `POST /v1/systemone` on a local port, or an in-process load. Shelling out avoids
  embedding a Python runtime in a Node process. An unreachable server means "not installed" —
  never an error.
- `classify(state, options)` → Laya `choice` with one option per candidate; return the option key
  and its confidence.
- `score(state, criteria)` → Laya `score`.
- **Latency budget: 33ms nominal.** Every call site gets a timeout — 200ms is generous. A slow
  helper must never add latency to a request; it degrades to the fallback.
- Laya's card warns that ordinal `score` is the weakest primitive. **Calibrate against a real
  probe before trusting its routing decisions.** A mis-routing helper is worse than no helper.

### R8.4 — Call sites and their fallbacks

| Call site | With the helper | Without |
|---|---|---|
| Modality classification (R5a.1 step 4) | Laya `choice` | deterministic from content parts — already sufficient |
| Provider scoring before dispatch | Laya `score` | registry `performance_score`, then name order |
| Reply validation | Laya `choice` over {refusal, tool_call, answer, degenerate} | the existing emptiness and tool-call-leak checks |
| Catalog/transcript retrieval | Needle embed | a plain relevance scan |
| Tool-call repair (R6 rung 4) | Needle generate | deterministic ladder, then a clean failure |
| Structured config/job reads | Needle extraction | a hand-rolled reader over the known columns |

Every fallback is already the current behaviour. The helper is a strict improvement on top of
something that works, never a repair for something that does not.

### R8.5 — Serving them as endpoints

Both appear in `/v1/models` when installed and are callable through the normal request path. This
is nearly free — they are catalog entries with an adapter that turns their non-standard interface
into the IR.

- Laya's `/v1/systemone` returns a decision structure, not a chat completion, so it needs its own
  `IRResponse` adapter: a `choice` result becomes text content, a `score` becomes a number, and
  the calibrated confidence becomes a routable signal.
- Needle's forced function call becomes `tool_calls` in the IR, and its `reasoning` and
  `confidence` fields map onto the `thinking` block and a usage-adjacent field.
- Presence in the catalog must reflect actual availability. A model advertised but not installed
  produces a request-time failure, which is the exact confusion FR-34 exists to prevent.

### R8.6 — Configuration

`enable_helpers` in `router_config`, default **0**. Helpers never load unless enabled. When enabled
but a specific helper is missing, log which one and continue.

---

## E2E test plan

The critical tests are the ones that run with helpers **absent** — they prove R8 is genuinely
optional, which is the phase's whole risk.

`test/phaseR8/helpers.test.ts`

1. **Absent is not an error** — with `enable_helpers: 1` and nothing installed, every endpoint
   works and every fallback fires. **The most important test in the phase.**
2. **The router imports cleanly** — with no helper module present on disk, the router starts. Not
   "the adapter returns null" but *the process starts*, proving nothing in the import graph
   requires it.
3. **Every fallback is correct** — modality classification, provider scoring, reply validation,
   retrieval, tool-call repair, and structured extraction each produce the documented fallback
   with helpers off. One test per site.
4. **Timeout degradation** — a helper that hangs past its budget. The request completes on the
   fallback within the budget. Assert elapsed time, not just the result.
5. **Adapter, Needle** — recorded output from a real `needle` run is mapped to the documented
   interface. Fixtures recorded from a live run, not hand-written.
6. **Adapter, Laya** — a recorded `/v1/systemone` response is mapped correctly.
7. **Needle empty list** — a declined extraction or repair produces a clean failure, not a
   fabricated empty result.
8. **Serving as an endpoint** — with a helper present, `/v1/models` lists it and a request to it
   returns a well-formed response in the caller's dialect.
9. **Advertised but not installed** — a catalog entry for an absent helper is not advertised.
   Assert `/v1/models` excludes it.
10. **Enable/disable at runtime** — toggling `enable_helpers` takes effect without a restart.
11. **Laya calibration** — provider scoring measured against known-good cases, asserting accuracy
    above a threshold and **logging the actual number** so a regression is visible. A
    mis-calibrated helper should fail this test.
12. **Checkpoint choice** — assert the adapter targets `laya-typed-decisions`. A test that merely
    checks "Laya is reachable" would pass against the 0.362-accuracy base checkpoint and ship a
    quietly worse router.

**Non-vacuity.** Tests 1, 2, and 12 are the ones most likely to pass while broken. Prove test 1 by
removing a fallback branch; prove test 2 by making the router import a helper module
unconditionally; prove test 12 by pointing the adapter at the base checkpoint and confirming the
test catches it.

---

## Success criteria

- **The router is complete and correct with neither model installed.** Verified by running the
  entire R0-R7 suite with helpers disabled and absent.
- No request fails, slows, or degrades because a helper is missing or slow.
- Needle performs semantic tool-call repair (R6), schema-guaranteed extraction, and embedding, when
  present and enabled — each with a defined fallback.
- Laya performs provider scoring, modality classification, and reply validation, targeting the
  typed-decisions checkpoint.
- Both are callable endpoints, advertised only when actually available.
- Calibration is measured against a threshold, and the measurement is logged rather than assumed.
- A helper exceeding its latency budget degrades to the fallback within budget.
- The existing suite is green and unchanged.
