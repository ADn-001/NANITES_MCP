# Phase R5b — Video, Long Audio, and Async Generation Jobs

**Goal:** the modality legs that need real generation and the ones that take minutes —
**text→video**, **video→text**, **text→audio**, **image→image** — behind a probe that decides
which of them actually ship.

**Depends on:** R5a (planner, capability data, artifact shape), R2 (SSE writer).

**This phase begins with a probe, not with code.** If the probe says the legs are not viable,
this phase shrinks to whatever did verify, and the async job layer goes with it.

---

## The probe

Before writing any of this, run a real probe against the configured providers and record what
comes back. The project's standing rule applies with full force here: **probe before parse.**

For each provider that advertises the modality, and for each leg in scope, record verbatim:

| What to capture | Why |
|---|---|
| The exact request that succeeded | It becomes the fixture |
| The response body's **exact** shape | Generators do not follow the chat-completions convention |
| Wall-clock duration | Decides sync vs job |
| Whether progress is reported, and how | Decides whether `progress` is ever non-null |
| Whether the artifact is inline, by URL, or by generation id | Decides the artifact mapping |
| The failure shape for an unsupported request | Decides the error mapping |

Minimum viable probe set:

1. **text→video** on OpenRouter — does a video model exist there, what does the request look like,
   how long does it take, is there progress?
2. **text→video** on any other configured provider
3. **video→text** — how is a video *sent*? URL, base64, file upload? Which models accept it?
4. **text→audio** — is speech generation served as a chat modality or a dedicated endpoint?
5. **image→image** — is it a model that takes an image prompt, or an edit endpoint?
6. **long audio→text** — the ceiling on input duration, and how a long file is passed

**The probe is a deliverable.** Its output becomes committed fixtures and a short findings note,
so the decisions below are auditable rather than remembered.

### What the probe is expected to show, and what happens either way

| Probe result | Consequence |
|---|---|
| Video works, seconds to a minute | Ship it synchronously if under the timeout, else as a job |
| Video works, minutes | Ship as a job with SSE progress |
| Video works but progress is opaque | Ship as a job; emit phase transitions only, `progress` stays null |
| Video is not offered by any configured provider | **Do not build the leg.** Report the gap, keep the cell `modality_unsupported` |
| Video input cannot be sent in any supported form | **Do not build video→text.** Report the gap |

A cell that cannot be built is a legitimate, documented outcome. A cell that is half-built and
mis-routes is not.

---

## Implementation directions

### R5b.1 — Async jobs

`router_jobs` (migration v29) and `src/router/jobs/` per §9 of the spec.

```
POST   /v1/jobs            {modality, model, input}  → {job_id, status:"queued"}
GET    /v1/jobs/:id                                   → {status, artifact|error}
GET    /v1/jobs/:id/events                            → SSE progress frames
DELETE /v1/jobs/:id                                   → cancel
```

Three properties that must hold:

- **Jobs are rows, not memory** (FR-49). The request IR is stored as JSON so a restart can resume
  or fail it deterministically.
- **Orphan recovery on boot**: a job left `running` whose provider call cannot be verified
  transitions to `failed` with `job_orphaned`. The repo already has this pattern for downloads;
  follow it.
- **Honest progress**: emit `phase` transitions always; emit numeric `progress` only when the
  provider supplies it. **Never synthesize a percentage from elapsed time.** A fabricated 80% on a
  three-minute video is worse than no number, because the user trusts it.

The `/v1/jobs/:id/events` stream reuses the `SseWriter` from R2 — the same writer, and that reuse
is why R2 built it as a general abstraction rather than an Anthropic-specific one.

### R5b.2 — Cancellation

A job the user cancels must actually stop spending money. The `AbortSignal` from the job's
upstream request is stored in an in-memory map keyed by `job_id`; `DELETE` aborts it and marks the
row `cancelled`. On restart, cancelled-but-still-running jobs go through orphan recovery.

Assert on a real abort signal, not on a boolean flag — a stubbed fetch that ignores `signal` will
pass a naive test.

### R5b.3 — Leg-by-leg implementation

Each leg is implemented only if its probe verified, and each is a small independent commit so a
leg that turns out to be wrong can be reverted alone.

- **text→video** — request shape from the probe; response decoded into `Artifact` with `kind:"video"`.
  Almost certainly a job.
- **video→text** — requires knowing how a video is *sent*. If it is a URL, the router's SSRF guard
  applies to it, and the URL must be reachable from the provider (not from the operator) — a
  localhost URL will not work. That is a real constraint and must be surfaced in the error, not
  discovered at request time.
- **text→audio** — may be a chat modality or a dedicated endpoint. Follow the probe.
- **image→image** — may be an image-prompt model or an edit endpoint. Follow the probe.

### R5b.4 — Catalog honesty

If a leg did not verify, its cells stay `modality_unsupported` **and** the models that would have
served it are marked so the catalog does not imply otherwise. A catalog that advertises a video
capability which then fails at request time is the exact confusion FR-34 exists to prevent.

Record the probe outcome per cell in the catalog, so a future run of the probe can detect when a
provider has added support.

### R5b.5 — Long-audio input limits

Audio and video inputs have provider-side size and duration ceilings. These must be enforced
**before** dispatch, with an error naming the model and the limit — not discovered as a 400 from
the provider after the bytes have been uploaded.

---

## E2E test plan

`test/phaseR5b/probe.test.ts` — the probe, made reproducible

1. **Probe fixtures are committed** — every leg's recorded request and response exist as fixtures.
   A test asserts the fixture set is non-empty for each leg that shipped, and that each fixture
   contains no credential.
2. **Probe re-runs are opt-in** — a live probe is behind an env flag and is skipped by default, so
   the suite is hermetic.
3. **Capability matches reality** — for every leg that shipped, the catalog capability that
   enabled it is set; for every leg that did not, the cell is `modality_unsupported` and the
   models serving it are marked. Assert both directions, so a capability cannot be set for a leg
   that does not work.

`test/phaseR5b/jobs.test.ts`

4. **Submit returns immediately** — `POST /v1/jobs` returns in under 100ms with a `job_id` while
   the provider is still working. Assert the timing, not just the response body.
5. **Progress phases** — the SSE stream emits `queued` → `running` → `finalizing` → `done` in
   order, and terminates.
6. **No fabricated progress** — a provider exposing no progress yields only `phase` events and
   `progress` stays null. Assert **no numeric frame is emitted**. The default provider has no
   progress, so this is the case that actually runs.
7. **Provider progress passes through** — a provider reporting 0.4 yields `progress: 0.4` verbatim.
8. **Restart survives** — create a job, kill the process mid-run, restart. The job is `failed`
   with `job_orphaned`, or resumed, and **never stuck in `running`**.
9. **Cancel aborts upstream** — `DELETE` transitions to `cancelled` and the provider's `AbortSignal`
   fires. Assert on a real abort.
10. **Long-generation ping** — a job exceeding 30s emits a keepalive on the events stream.
11. **Oversize input rejected pre-dispatch** — an audio input over the model's limit fails with the
    model and limit named, and **the provider is never contacted**. Assert on the fetch call log.

`test/phaseR5b/legs.test.ts` — one block per shipped leg, skipped for unshipped ones

12. Each shipped leg's full path: submit → stream → artifact, asserted against its committed
    fixture. A leg that did not verify has its test skipped with a reason, so a skipped test is
    visible rather than absent.
13. **URL-reachability error** — a video URL pointing at `127.0.0.1` returns an error explaining
    that the provider cannot reach it. This is a confusing failure that must be explicit.

**Non-vacuity.** Test 6 is the one most likely to pass while broken — a progress emitter that
synthesises from elapsed time produces perfectly plausible frames. Test 11 likewise passes if the
provider happens to reject an oversize payload for its own reasons; the assertion must be on the
fetch log.

---

## Success criteria

- A committed probe record with fixtures exists for every leg that shipped, and a findings note
  explains every leg that did not.
- Every leg that shipped works end to end, asserted against a recorded fixture.
- Every leg that did not verify is `modality_unsupported` and marked in the catalog, so nothing
  implies otherwise.
- Generation jobs return immediately, stream honest progress, survive a restart, and can be
  cancelled with a real upstream abort.
- No synthetic progress percentage is ever emitted.
- Oversize media inputs are rejected before dispatch, naming the model and the limit.
- If the async job layer was not needed, it was not built.
- The existing suite is green and unchanged.
