# Phase R5a — Modality Core: Classification, Capability, Pins, Audio and Image

**Goal:** modality classification, real capability data, the planner, pins, and the two legs that
are cheap and well-supported — **audio→text** and **image→text** — plus the text→image generation
leg where a provider supports it.

**Depends on:** R4 (catalog with capabilities), R2 (SSE writer).

**Split from the original R5.** R5 was the largest phase in the project and it bundled two very
different kinds of work: routing infrastructure that is cheap to build and stable, and four
generation legs whose feasibility is unknown until each provider is actually probed. Bundling them
meant the unknown work gated the known work. R5a ships the foundation and the verified legs; R5b
ships what the probe says is worth shipping.

**Video is explicitly out of R5a.** See R5b.

---

## What R5a covers

| Cell | Status here |
|---|---|
| text→text | **yes** — direct |
| image→text | **yes** — caption, via the existing vision path |
| audio→text | **yes** — transcription |
| text→image | **yes** — generation, where a provider advertises it |
| image→image, text→audio, text→video, video→anything, audio→{image,video} | no — R5b |

---

## Implementation directions

### R5a.1 — Modality classification

When the caller does not declare the output modality, classify it:

1. explicitly, from the request field if present
2. deterministically, from the content parts — an `input_audio` part means audio in; an image URL
   means image in
3. from the target model chain's declared modalities
4. via Laya's `choice` primitive, when helpers are enabled and the first three are inconclusive
5. otherwise `text`, the safe default

Steps 1–3 are always available. Laya (R8) strictly improves step 4 and is never a dependency
for it.

### R5a.2 — Capability population (the hard prerequisite)

`ProviderCapabilities` already declares `{vision, audio, video, function_calling, reasoning?}` and
`provider_models.supported_modalities` already has a column — but **nothing populates audio or
video** (`src/storage/providerModelStore.ts:60-65` writes only `["text"]` or `["image","text"]`),
and nothing reads them. `parseModalities` exists at `src/providers/client.ts:70-77`, unused.

For R5a, populate capabilities for **text, image, and audio** only:

- **OpenRouter** publishes an `architecture` block with `input_modalities` and
  `output_modalities`. That is the source, parsed directly.
- **Cloudflare and NIM** do not publish the same shape. Their capability data is either seeded
  from a manifest or **left null**. No guessing.
- `parseModalities` is presumably the intended home; check it against real provider output before
  trusting it. Per the project's standing rule: **probe before parse.**

**Null means unknown, not false.** A model with unknown modalities is not a candidate. This is the
whole discipline — guessing produces silent wrong-route failures where a text request goes to a
model that cannot accept it.

### R5a.3 — Direct vs convert-then-route

`planModality` per §8 of the spec, in order: pin → native direct → convert-then-route →
`modality_unsupported`.

Direct wins: one hop instead of two, one model call, one set of tokens, no lossy intermediate.
Convert-then-route exists for when no single model does both legs.

- **image→text** reuses `src/providers/vision.ts`, which exists and is tested
  (`test/phase62/visionConfinement.test.ts`).
- **audio→text** transcribes with an audio-in model, then routes the transcript as text.

### R5a.4 — Pins

`router_modality_pins` (migration v28) keyed `(source, target)`. A pin overrides the planner
entirely. Set via `nanites_router_setModalityPin` and in the dashboard. This is the mechanism by
which the orchestrator steers modality routing (D14).

### R5a.5 — Text→image generation

The first generation leg, because image generation is the most widely advertised and the best
documented.

**A generation response is not a chat completion.** OpenRouter returns images through a
`modalities` field on `/api/v1/chat/completions`, and image results are additionally retrievable
by generation id from `GET /api/v1/generation?id=…`. So a dedicated decoder
(`src/router/modalities/generation.ts`) is required — `parseChatResponse` will not do it.

**Text→image is synchronous, not a job.** Image generation completes in seconds, well inside the
existing 240s request timeout. R5a returns the artifact inline. Only the genuinely slow legs
(text→audio for long audio, text→video) become async jobs in R5b, and the job infrastructure
lands there with them. Splitting it this way means R5a needs no job store, no orphan recovery, and
no progress streaming — and if R5b's video work turns out to be infeasible, the job layer is
skipped entirely.

Artifact shape, uniform at the router's boundary and provider-specific underneath:

```ts
export interface Artifact {
  kind: "image" | "audio" | "video";
  uri: string;          // data: URL or a fetchable URI
  mime: string;
  bytes?: number;
  generation_id?: string;
  duration_ms?: number;
}
```

### R5a.6 — Modality-aware test prompts (FR-7, FR-8)

The existing generated-prompt test is text→text. Extend for the R5a modalities: image models get a
"describe this image" prompt, audio models a transcription prompt, image-generation models a
"generate a X" prompt. Each needs a suitable fixture — small, committed, free of licensing
ambiguity.

---

## E2E test plan

`test/phaseR5a/modalityCore.test.ts`

1. **Capability population** — for each provider, a stubbed `/models` payload is parsed and the
   resulting `supported_modalities` is asserted field by field. Written against a **recorded real
   response**, not a hand-written sample.
2. **Unknown stays unknown** — a model with no published modalities has `supported_modalities`
   null and is **not** selected by the planner. Assert the planner returns `null` rather than
   defaulting to text. **This is the most important test in the phase.**
3. **Direct preferred** — both a native multimodal model and a text model exist for image→text.
   The native one is chosen and the call count is 1.
4. **Convert-then-route** — no native model; the call count is 2, the first to a captioning model,
   the second to the text target, and the transcript from the first is the input to the second.
5. **Pin override** — a pin exists; the planner returns `pinned: true` and the pinned model
   regardless of what else the catalog offers.
6. **Unsupported pair** — audio→image with no capable model: `modality_unsupported` naming the
   pair, and **no provider is contacted**.
7. **Audio leg** — an `input_audio` part is classified as audio, routed to transcription, and the
   transcript flows onward.
8. **Image leg** — reuses the existing vision path; the `test/phase62` vision confinement tests
   must still pass, and a new test asserts the router honours `NANITES_VISION_ROOTS`.
9. **Classification without declaration** — the caller sends audio and declares nothing; the
   router classifies correctly from the content parts.
10. **Explicit declaration wins** — the caller declares text for an image request; the declaration
    is honoured.

`test/phaseR5a/imageGeneration.test.ts`

11. **Inline generation** — a text→image request returns an `Artifact` inline, in under the
    synchronous timeout, with no job created. Assert `router_jobs` is still empty.
12. **Generation decode** — a **recorded** OpenRouter image-generation response decodes to the
    uniform artifact shape. Not a hand-written sample.
13. **Retrieval by generation id** — when the response carries a `generation_id`, the follow-up
    fetch works and returns the same image. Assert both paths.
14. **Provider with no image support** — `modality_unsupported`, no provider contacted.
15. **Per-modality test prompts** — each R5a modality's generated prompt is well-formed and its
    fixture exists.

**Non-vacuity.** Test 2 and test 15's fixture check are the two that pass while broken — a planner
that defaults unknown to text looks fine in a happy path. Break each deliberately and confirm the
test catches it.

---

## Success criteria

- Capability data is populated from what providers actually publish, and null where they publish
  nothing.
- Unknown capabilities are treated as unknown, never guessed.
- A natively multimodal model is always preferred over a two-hop conversion.
- Pins override the planner and are settable from MCP and the dashboard.
- audio→text, image→text, and text→image all work end to end against a real provider.
- Every R5a cell either routes correctly or returns `modality_unsupported` naming the pair. No cell
  silently mis-routes.
- No async job machinery was built — it is deferred to R5b with the legs that need it.
- The existing suite is green and unchanged, including the vision confinement tests.
