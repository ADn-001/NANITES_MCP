# Nanites — GATELOG (phase gate ledger)

Append-only phase log for the sprint defined in
`docs/27_systemic-fixes-btw-implementation-plan.md`. **Check this file before
starting any phase.** Each phase appends a `## Phase <id>` entry with Status /
Date / Notes when its gate is confirmed — never edit a past entry. GATELOG is
load-bearing inter-session memory: downstream phases (and future sessions)
read it to know what actually shipped and what a live probe decided.

**Ground rules for the sprint:** never batch phases; implement → write the
phase's test suite → run → fix until green → never weaken tests → confirm gate
→ append below → next phase. Additive changes only.

**Live-probe dependency:** Phase B opens with the consolidated live probe
(tokenize endpoint / embeddings endpoint / load progress / VRAM surface). It
needs LM Studio running on the live endpoint. Its findings are recorded in the
Phase B Notes and reused by D (tokenizer provider), H (retrieval), and G
(VRAM).

## Phase registry

Order is the implementation order (A→B→C→D→E→H→F→G). A–D are btw
prerequisites; E (registry scoring) runs before H so btw's `context_qa`
selection is fixed; F runs after H so its drift-guard covers btw's new
prompt/command.

| Order | Phase | Spec | Suite | Migration | Status | Date | Notes |
|---|---|---|---|---|---|---|---|
| 1 | A | systemic-fixes | test/phase27 | — | ⬜ Not started | | `hold` option on runSubAgent |
| 2 | B | systemic-fixes | test/phase28 | — | ✅ Confirmed | 2026-09-04 | idle timeouts + live probe |
| 3 | C | systemic-fixes | test/phase29 | v10 (jobs) | ✅ Confirmed | 2026-09-04 | async-job pattern, FIFO (job-mode) |
| 4 | D | systemic-fixes | test/phase30 | — | ✅ Confirmed | 2026-09-04 | tokenizer seam; provider after probe |
| 5 | E | systemic-fixes + Handoff 26 | test/phase31 | v11 (test_results/param_search/registry) | ✅ Confirmed | 2026-09-04 | registry scoring + regimen-state fixes |
| 6 | H | btw-spec-v2 | test/phase32 | v12 (btw tables + guarded vec0) | ✅ Confirmed | 2026-09-04 | `/nanites-btw` feature (H1–H5) |
| 7 | F | systemic-fixes | test/phase33 | — | ✅ Confirmed | 2026-09-04 | SKILL dedupe + command drift-guard |
| 8 | G | systemic-fixes (Tier 3) | test/phase34 | — | ✅ Confirmed | 2026-09-04 | staleness signal + cross-profile share + live-VRAM advisory |

---

## Phase A — Load/unload lifecycle: additive `hold` option

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:** `runSubAgent` now accepts `hold?: { instance_id_out?, max_hold_ms? }`
and returns `held_instance_id` when the call loaded the model. Default teardown
unchanged (additive only; MCP `run_sub_agent` schema untouched — `hold` is an
internal-function seam for the btw map-step and held chat instance). When held,
teardown is skipped and the warm instance is handed to the caller; a
`model_hold.start` event carries the advisory `max_hold_ms` for the future idle
sweep. Held instances are ordinary slot occupants (a later sequential
acquisition evicts them). Harness extended (`test/phase8/helpers.ts`
`RunAgentOptions.hold`). New suite `test/phase27/hold.test.ts` (6 tests).
Full suite green: 61 files / 470 tests; typecheck clean. Test dir allocated to
Phase A as planned (27).

---

## Live probe — LM Studio capability record (2026-09-04)

Consolidated read-only probe of the live endpoint at `http://127.0.0.1:1234`
(active profile `TEST`, Bearer auth present). Script: `scripts/live-probe.mjs`
(`NANITES_HOME` + optional profile name). Findings are reused by D (tokenize),
H (embeddings), and G (VRAM). This is not a phase-gate entry; Phase B's gate
entry references it for its load-mechanism decision.

| Question | Finding |
|---|---|
| Reachability / auth | `/api/v1/models` → 200 with Bearer token; 401 without. |
| Inventory | 17 models: 16 `llm` + 1 `embedding` (`text-embedding-nomic-embed-text-v1.5`). **0 loaded** at probe time. |
| VRAM in listModels | **No** live VRAM/memory fields in the listModels response. |
| OpenAPI inventory | `/openapi.json` returns a 200-with-error stub (`"Unexpected endpoint or method"`), **not** a spec. No path inventory available. |
| Tokenize endpoint | `/api/v1/tokenize` → 404. **No live tokenize endpoint** → D5/D6: build the local HF-tokenizers provider branch (no server route to call). |
| Embeddings endpoint | `/api/v1/embeddings` → 404. `/api/v0/embeddings` → 400 `"No models loaded"` (route **exists at v0**, needs an embedding model resident). → H retrieval targets `/api/v0/embeddings` and must load `text-embedding-nomic-embed-text-v1.5` first. |
| System/VRAM endpoints | All read-only candidates 404 (`/api/v1/system/info`, `/system/health`, `/server/info`, `/gpu`, `/memory`, `/hardware`). → G: no live VRAM surface on this build; profile-spec + size-based estimate (as `ui/server.ts` already does) is the only signal. |
| Load progress/async | No async/load-status surface discoverable; GET `/api/v1/models/load` → 404. Blocking-POST assumption from docs/06 stands → **Phase B selects the B-else branch**: blocking load on an `AbortController`, parallel ~2s heartbeat reachability poll, existing `loadTimeoutFor` as outer ceiling. Docs-confirmed, not empirically load-tested (a real load consumes VRAM; probe stayed read-only). |
| TTFT / normal idle gaps | Unmeasured (no model loaded; probe avoids loads). Default generation idle (30s) stands. |

---

## Phase B — Idle-based timeouts (probe-gated): generation + load

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:** Kills on **silence, never elapsed time**. The generation path
(`streamChatIdle` in `src/lmstudio/client.ts`) arms an idle timer reset on every
SSE event — a model still emitting is never cut off. Three killers: `first_event`
(no event within the client budget → keeps the old deterministic `/timed out/i`
contract for explicit small budgets), `idle` (no event for the window →
`generation_idle_timeout`, default 30s constant `GENERATION_IDLE_TIMEOUT_MS`),
and `ceiling` (`SOFT_CEILING_MULT`=4× budget, belt-and-suspenders). The load
path (`loadModelWithHeartbeat`) heartbeats `GET /api/v1/models` on a ~2s cadence
while the blocking load POST is in flight, aborting only when the endpoint goes
silent for `LOAD_HEARTBEAT_IDLE_MS` (30s) → `load_idle_timeout`; never partial
execution. Seam constants in `src/helpers/idleTimeout.ts`. Probe decision honored:
live endpoint has no async/load-status surface → B-else branch (blocking load +
heartbeat), recorded above. Callers: `runSubAgent` passes
`idle_timeout_ms ?? GENERATION_IDLE_TIMEOUT_MS` on its streaming (tool-less) chat
and uses `loadModelWithHeartbeat` at both acquire sites; `runTestRegimen` streams
unit chats idle-killed. New suite `test/phase28/` (7 tests: slow-but-alive past
the old budget completes; mid-run stall → `generation_idle_timeout` + unload
exactly once; regimen unit stall → same; pre-first-byte silence keeps the old
fixed-budget contract; slow load answering heartbeats completes; silent endpoint
→ `load_idle_timeout`; defaults locked). Harnesses extended (phase7/phase8/phase9
mock chats now answer `stream:true` over SSE; `openChatStream` in
`test/phase1/mockServer.ts`; `chatSlow`/`chatStall`/`loadDelayMs` mock modes).
Full suite green: 63 files / 477 tests; typecheck clean.

---

## Phase C — Async-job pattern: SQLite `jobs` table + FIFO (job-mode only)

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:** Generalized the download/status async pattern into a `jobs` SQLite
table (migration v10) + in-process runner. The queue IS the DB — status
transitions are guarded single-row UPDATEs (`WHERE status='queued'`), race-safe
across processes on the same NANITES_HOME; `markRunning` returns false if someone
else claimed first. New `start_sub_agent_job` (returns `job_id` synchronously,
fire-and-forget drain via `queueMicrotask`) and `get_sub_agent_job_status`
(`{job_id, status, result?}`; `job_not_found` structured error) MCP tools.
Blocking `run_sub_agent` / `run_test_regimen` keep their single-call contracts —
job-mode is additive only. FIFO lives in the runner, not the pool: one shared
`SubAgentPool` per profile (capacity = `concurrency.max_parallel_models`);
`JobRunner` only launches when `pool.tryAcquire()` succeeds, so a job whose
profile is at capacity stays queued and completes in enqueue order instead of
refusing `concurrency_limit`. **Decision:** only the `sub_agent` kind is
registered now (per plan Task 7 — regimen/sweep deferred until free); the
`register(kind, handler)` seam supports btw compaction etc. later.
`SubAgentPool` itself is unchanged for blocking callers (hard-refuse at capacity
still tested). Wipe scope extended to `jobs` (ephemeral bucket:
`/api/settings/wipe` now also clears `deleteBefore`/`deleteAll`); reconciled
`test/phase15/wipe.test.ts` expectations (jobs counts 1/2 + rows cleared).
Error persistence: `markError` stores the structured `{code, message, retryable,
details?}` in `result` plus `error_code`/`error_message` columns (no extra
retryable column — faithful to the plan's column list). New suite
`test/phase29/` (13 tests: job lifecycle queued→running→done with
run_sub_agent-shaped result; no result while queued/running, result on done;
chat-fail job → `error` and slot released for a following job; FIFO completion
order [a,b,c] at capacity; blocking refusal intact; store reopen persistence;
guarded markRunning; deleteBefore/deleteAll scopes; migration v10 columns +
queued default + index). Migration chain clean up-from-empty on a scratch home
(user_version 10, `idx_jobs_status_created` present). Full suite green: 67 files
/ 487 tests; typecheck clean. No live-server dependency for this phase (all mock
LM Studio); LM Studio online note carried forward — next live probe gates D.

---

## Phase D — Tokenizer consolidation: seam now, provider per probe

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:** Single token-count seam + probe-selected provider branch.

**Live probe re-check (auth disabled for this probe).** The Phase-B record
("no live tokenize endpoint") only scanned `/api/v1`. Re-probed while LM Studio
is reachable: `POST /api/v1/tokenize` → 404; `POST /api/v0/tokenize` → HTTP 200
but body `{"error":"Unexpected endpoint or method."}` — the same 200-stub as
`/openapi.json` (Phase-B finding), i.e. a **false positive**, not a route. No
tokenize endpoint exists anywhere → **D5/D6 branch chosen: local
`@huggingface/tokenizers` provider** (never a server route to call). This
corrects/extends the Phase-B row without editing it (GATELOG is append-only).

**Audit (D0).** Only one heuristic estimator exists in src —
`countTokens` = chars/4 in `helpers/tokenCounter.ts` — and both its consumers
already shared it (runSubAgent planner `promptTokens` + the no-stats
`usageEstimate` fallback). `usageFromStats` and cost reporting are
authoritative (server `ChatStats` → `sub_agent_calls` rows; ledger reads logged
tokens, no re-estimation). So the deliverable was one seam module + contract,
not fixing N divergent estimators.

**Seam + migration (D1–D2).** New `src/helpers/tokenize.ts` is the single
counting module: `countTokens(text)` keeps the pre-seam numeric contract
byte-identical (`""`→0, else `max(1, round(len/4))`), never throws, sane for
empty/whitespace/control-heavy input; `countTokensAccurate(text, opts?)` async
consults a pluggable `TokenizerProvider` and falls back to chars/4 on null /
garbage / throw (never hard-fails — btw chunking always gets *a* number).
`tokenCounter.ts` now owns only usage accounting (`TokenUsage`,
`usageFromStats`, `usageEstimate`) and re-exports `countTokens` from the seam.
`runSubAgent.ts` imports the estimator from the seam. Existing call sites
unshifted (phase2/phase24/phase25 pinned suites green after migration).

**Provider (D3, probe-gated; user chose full-provider-now).** Added dependency
`@huggingface/tokenizers` ^0.1.3 (WASM; verified loads + counts under Node 24
win32). `src/helpers/tokenizerProvider.ts` resolves per repo id (registry
`source` namespace; explicit `repoId` wins, else a slash-shaped `modelId`):
per-process memo → disk cache (`NANITES_HOME/tokenizers/<repo>.json`) → local
LM Studio models dir (env `NANITES_LMSTUDIO_MODELS_DIR`) → HF fetch (only with
`NANITES_HF_FETCH=1`, short timeout). Counts with `add_special_tokens:false`.
Never hard-fails: any unresolvable model / offline miss / load error → null →
chars/4. **Fleet finding surfaced to user:** the local fleet is GGUF-only
(embedded tokenizers; no `tokenizer.json` in the model dirs), so local-dir
sourcing is effectively dead here and accurate counts only fire once Phase E/H
plumb the registry `source` repo id — the provider is the capability; resolution
keys arrive later. `buildDeps` registers an HF default provider (cache rooted
under each home; fetch off by default). Fixture-driven tests (vendored
WordPiece `tokenizer.json`, no network): cache-hit count differs from chars/4
(5 vs 7), local-dir source primes the cache, unresolved/offline never throws,
traversal-shaped repo keys rejected. HF-fetch path exercised as documented skip
(offline). New suite `test/phase30/` (12 tests). Full suite green: 69 files /
499 tests; typecheck clean. No migration (D adds no tables). Downstream: F-2
planner silent-fallback `note` and H's `summary_tokens` both ride this seam.

---

## Phase E — Registry scoring, ranking, and regimen-state fixes (Handoff 26)

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:** Largest phase; internal checkpoints E1–E6 + E-req, one gate.

**Inter-session-critical semantic change: registry `scores` are now ROLE-KEYED
means, never unit-keyed.** `roleMatch.findBestModel` always read `entry.scores[role]`;
it only now receives real data. `roles` = sorted union of the tested units'
`applicable_roles`; `scores[role]` = mean over the per-unit *winner* approved rows of
the **latest `test_run`**; `score_minima[role]` = that role's min (feeds the E3
low-confidence floor). **Downstream readers must treat registry scores as
role→mean:** btw (Phase H) role selection and SKILL.md delegation guidance both
rely on this shape — anything written earlier assuming unit-id keys is stale.

- **E0 / migration v11:** `test_results` + `candidate` (default `'baseline'`) +
  `test_run` (default 0) + partial unique index `idx_test_results_pending
  (profile_name, model_id, unit_id, candidate) WHERE status='pending'`;
  `param_search_attempts` + nullable `unit_id`/`candidate` (attribution);
  `model_registry` + `score_minima` (default `'{}'`). New internal `staged`
  status (plain TEXT; variant output held, invisible to listPending/
  getPendingJudgments/finalize until promoted).
  **Upgrade-risk flag:** the partial unique index demands pre-existing pending
  rows be unique per (unit, candidate). A DB polluted by the old D1 stacking
  (duplicate pending rows for one unit) would fail `CREATE UNIQUE INDEX`. Spec
  prescribed this exact SQL, so no dedupe step was added — clean DBs migrate
  fine; anyone upgrading a stacked DB must dedupe first. `staged`/`approved`
  rows are outside the index scope.
- **E1 aggregation (`finalize.ts` + shared `scoreAggregate.ts`):** approved rows
  of the latest test_run collapse per unit to the highest-scoring candidate
  (winner); each winner contributes to every `applicable_role`; mean→`scores`,
  min→`score_minima`. Older-run approved rows excluded. Shared by finalize and
  the legacy backfill so both trace to one rule. Re-finalize is idempotent.
- **E2:** no code change; `roleMatch.ts` carries a comment that best-of-requested
  (`Math.max` over matched roles) is intentional — do not "fix" to a mean.
- **E3:** `FITNESS_FLOOR = 50` exported from `roleMatch.ts`. `runSubAgent`'s
  default (registry) branch flags `low_confidence: true` + a human `note` when a
  matched role's `score_minima` is undefined or `< floor`. Additive; selection
  unchanged; offMode/explicit-model paths untouched. Floor configurability
  deliberately deferred (flag, not wired).
- **E4 — judged-under-both + serial judging + idempotent pending:**
  `runTestRegimen` runs judged units under BOTH candidates (baseline→`pending`,
  variant→`staged`) but logs **no** param attempt at run time (score unknown,
  D10); every row is stamped with the run (max+1). A unit already holding a live
  pending/staged row is skipped and `stampRun`-adopted into the current run —
  re-runs cannot stack rows or double judged chats. `submitTestJudgment` records
  the judgment on the pending candidate, logs its attempt **with the real score**
  at submit time (continuing the counter), promotes baseline→variant staged→
  pending, then finalizes. Net: 2 model runs + 2 judgment passes per unit, one
  pending row visible at a time. **Recorded deviation from a literal D10
  reading:** a `user_approved:false` candidate is NOT logged to the param search —
  `best_params` must never prefer a config whose output the user rejected
  (comment in `submitTestJudgment.ts`).
- **E5 backfill (`backfillScores.ts`):** pure transform, zero LM Studio calls.
  Lazily triggered by `read_registry` when an entry has non-vocab score/minima
  keys or a missing `score_minima`; recompute source priority rows-first → legacy
  unit-keyed scores mapped through `applicable_roles` → keep valid role keys with
  a single-sample floor. **E5-side write guard:** `write_registry_entry`
  validates against the profile's role vocabulary = the 10 built-ins ∪ roles on
  its registered test units (never hard-closed to 10) — rejects unit-id keys /
  unknown roles / out-of-range (0–100) values with structured
  `registry_entry_invalid`; auto-fills `score_minima` from `scores` when omitted.
- **E6 best_params split:** registry `best_params` now carries sampling params
  only (`samplingParamsOnly`: temperature/top_p/top_k/min_p/repeat_penalty). The
  inference planner remains sole owner of output-token/context/reasoning sizing.
- **E-req sweep:** `runUntestedSweep` sorts candidates ascending by `size_bytes`
  (unknown size last, ties by model id) and wraps each model's regimen in
  try/catch — a failure records `{model_id, error}` in a new `failures` array and
  the sweep continues.
- **Reconciliation (spec item 8):** phase7 workflow + phase11 DoD suites updated
  to serial two-pass judging and the role-keyed aggregation oracle (entry keys =
  role union, means/minima, sampling-only best_params). phase5 registry-tool
  fixtures moved off junk vocab (`roles:["code"]`/`scores:{quality}` → canonical
  role keys) so they survive E5-side validation/backfill. No suite weakened.
- **Suite:** new `test/phase31/` (16 tests across 6 files): E1 aggregation
  unit test (role means/minima over the latest run only, per-unit candidate
  collapse), re-finalize idempotency + no unit-key residue, selector integration
  (higher role mean wins; E2 best-of-requested; no-data role never outranks a
  scored role of the same tier), E3 low-confidence flag via `run_sub_agent`
  (below/absent floor flags, at/above stays silent), idempotent pending (no
  stacked rows, no doubled chats, surviving rows re-stamped), serial judged flow
  end to end (baseline pends → submit logs attempt + promotes staged → variant
  judged → winner aggregated → sampling-only best_params reflecting the
  higher-scoring candidate), `write_registry_entry` validation incl. custom-unit
  roles, sweep ascending order + per-model resilience, and migration v11 up/down
  (legacy-row upgrade + idempotent-pending index semantics + clean re-apply).
  Full suite green: 75 files / 515 tests; typecheck clean. No live-server
  dependency (all mock LM Studio). E's live probes stay deferred to H's first
  live check (btw selection) per the sprint plan.

---

## Note — migration v11 hardened: stacked-pending dedupe (2026-09-04)

Not a phase gate; corrects/extends the Phase E "Upgrade-risk flag" above without
editing it (GATELOG is append-only). The v11 migration originally created
`idx_test_results_pending` unconditionally, so a pre-v11 DB carrying the D1
stacking bug (duplicate `pending` rows for one unit) would have failed the
`CREATE UNIQUE INDEX` and rolled back, stranding the DB at v10. Now v11 first
collapses each unit to its **newest** pending row (`DELETE ... WHERE id NOT IN
(SELECT MAX(id) ... GROUP BY profile_name, model_id, unit_id)`), then builds the
index. Non-pending rows are never touched. User confirmed all DB contents are
disposable test data, authorizing in-place collapse of superseded pending
output. `test/phase31/migration.test.ts` gained the stacked-upgrade case (two
pending rows for one unit → migration succeeds, newest survivor, judged rows
untouched, index enforced). Full suite green: 75 files / 516 tests; typecheck
clean.

---

## Note — WebSocket tokenizer provider (user decision for Phase H)

Not a phase gate; a forward commitment read by Phase H. User found that LM
Studio exposes tokenization only through its SDK WebSocket channel
(`client.llm.model().tokenize`), not raw HTTP REST. Verified: `@lmstudio/sdk`
v1.5.0 exists on npm; Node 24 ships a global `WebSocket`; the SDK's tokenize
requires a **loaded** model handle. This does NOT reopen Phase D (confirmed
2026-09-04): Nanites' primary counting is pre-load planning
(`runSubAgent` `promptTokens` feed `context_length` before acquire) plus
offline/unloaded-GGUF, which a loaded-handle path cannot serve — chars/4 +
HF-from-source stays the correct offline baseline and D stands as gated.

**Decision (user, 2026-09-04):** implement the WebSocket tokenizer in **Phase
H** as an additive provider on the Phase-D seam — server-authoritative first
when a loaded handle exists, HF-from-source next, chars/4 last. Real value is
post-load exact counts: H2's map-step holds the summarizer (a resident model
exists without an extra load), H3 held-chat turns, and `summary_tokens`.
**Probe gate at H's first live check:** if ws tokenize works against a loaded
model, wire `@lmstudio/sdk` as a per-profile provider; else record the outcome
and keep HF-from-source. Never hard-fail; never a second protocol at rest.

---

## Phase H — `/nanites-btw`, one active chat per profile (btw-spec-v2; internal checkpoints H1–H5)

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:** Full `/nanites-btw` feature; internal checkpoints H1–H5, one gate
(`test/phase32`).

- **H1 — stores + migration v12:** `btw_chat` (one active chat per profile; no
  session ids), `btw_chat_messages` (user/assistant turns, `turn_index`),
  `btw_chunks` (compaction corpus, `chunk_id = c{msg_start}`). v12 guards the
  vec0 extension load behind a non-literal `const spec = "sqlite-vec"; await
  import(spec)`. `POST /api/settings/wipe` widened to clear the btw tables and
  the compaction cache buckets alongside the log tables; the phase15 wipe suite
  was additively updated to count them (reported at 0 when unseeded) — no test
  weakened.
- **H2 — compaction as a Phase-C job:** kind `btw_compact` runs on the profile's
  FIFO slot like any job-mode kind — queued behind a running real sub-agent job,
  never preempting or ejecting it (phase32/fifo proves it). Compaction loads the
  summarizer once (`acquireModel`), one map chat per chunk, one reduce chat, and
  unloads once only when it loaded the model itself; each model chat writes a
  `sub_agent_calls` row (role `context_chunk_summarizer`, tasks `btw map
  <start>-<end>` / `btw reduce`). Cache statuses
  `cold | hit_no_diff | diffed | invalidated_full_rebuild`; divergence detection
  = `commonPrefixLength` over message hashes (`diverged ⇒ newStart 0`, else
  resume at the prefix). `start_btw_chat` resets the transcript/chunks but
  preserves `context_cache` + `context_summary_cache`.
- **H3 — held `context_qa` chat:** a dashboard turn chats the pinned QA model
  directly against its held instance (never through `run_sub_agent`), logged
  under the `context_qa` role for cost. Next turn reuses the resident instance (0
  loads); an evicted/crashed instance is silently reacquired (1 reload);
  `sweepIdleBtwChats` frees only the instance — the row + transcript survive and
  the next message reloads. Registry role selection via
  `roleMatch.findBestModel` over the E role-keyed `scores`.
- **H4 — UI:** `GET /api/btw/state` (polled snapshot; never exposes instance ids)
  + `POST /api/btw/message` (structured errors: retryable→503,
  `btw_chat_not_found`/`no_model_for_role`→409, malformed→400). Dashboard gains a
  chat-mode surface in `#voxPanel` driven by SSE `chat.content`/`chat.reply` →
  `btwStreamEvent` draft streaming (1500 ms poll) and a deep link
  `http://127.0.0.1:{port}/#/vox-terminus?mode=btw&maximize=1&q=…` (one-shot
  prefill + hash strip). Verified live in the browser preview pane: deep-link
  route into chat mode, maximize, send round-trip with a structured 409 turn,
  exit back to STREAMING, no console errors.
- **H5 — tool + prompt:** `start_btw_chat` MCP tool + `/nanites-btw` prompt entry
  point. Keyword-overlap retrieval is the effective path; no-match returns [].
- **Environmental answers:** sqlite-vec cannot load under `node:sqlite` on this
  Windows box — the vector branch stays present but `init()` reports false and
  keyword overlap answers, never throwing or hanging (documented skip). WebSocket
  tokenizer: **not wired this gate** — no loaded-handle live check ran
  (phase32 is all-mock); per the forward note above the decision stays open and
  chars/4 + HF-from-source remains the baseline — never a hard-fail path.
- **Suite:** new `test/phase32/` (6 files, 19 tests): cache-status state machine
  + reset-preserves-caches, compaction load/ledger/chunk provenance, held-chat
  reuse/eviction-reacquire/idle-sweep, UI REST round-trip + wipe + deep link +
  dashboard-artifact markers, FIFO non-preemption, keyword retrieval + vector
  skip. Full suite green: 81 files / 535 tests; typecheck clean; `npm run build`
  refreshed `dist/ui/index.html`.

---

## Phase F — Duplication cleanup: SKILL single-source + command drift-guard (D8)

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:** Three additive tasks, one gate (`test/phase33`).

- **F1 — SKILL.md single-source.** New `scripts/copy-skill.mjs` (build step, now
  `tsc → copy-ui → copy-skill`) copies the canonical skill
  `plugin/nanites/skills/nanites/SKILL.md` (ships with frontmatter) to the
  generated artifact `.claude/skills/nanites/SKILL.md`. The sweep's finding
  confirmed: the hand-synced `.claude` copy had drifted — a 10-line diff, the
  whole frontmatter block. Artifact is now byte-identical to canonical and the
  script refuses a frontmatter-less canonical file.
- **F2 — planner silent-fallback note.** `planInference` takes an additive
  `unknownContextCeiling` input; when model discovery fails during
  `run_sub_agent` (`discoveryFailed` flag in the best-effort `listModels`
  catch), the planner folds a "ceiling unknowable — planned against the default
  32768 ceiling" note in (composing with its own reasoning-skip note, never
  replacing it). `runSubAgent` now surfaces the planner note in the response
  beside the E3 confidence note — both share the single human `note` slot;
  `low_confidence` flag semantics unchanged.
- **F3 — commands drift-guard.** New `src/server/commandsManifest.ts`: declared
  `COMMAND_SHEETS` (all 9 sheets, each with its paired prompt + expected
  frontmatter `argument-hint`) + `PROMPT_ONLY_SHEETLESS`
  (`nanites-switch-profile`, `nanites-btw`) + pure parsers (`toolMentions`,
  `registeredPromptNames`, `promptFirstTool`, `registeredToolNames` from the
  register sites incl. `nanites_ping`) + `surfaceProblems` (pure) and the
  repo-backed `checkNanitesSurface`. Rules: every sheet declared (no
  undocumented file, no dangling entry); every registered prompt declared
  (paired or sheetless); every tool a sheet names resolves to a registered
  tool; a paired sheet's first step equals its prompt's first tool call (catches
  a dropped resolution step); sheet `argument-hint` == declared. **cost-saved
  sheet fixed**: it was missing the `get_active_profile` resolution step (its
  prompt had it) and its hint was the stale `[7d|30d|all]` vs the report tool's
  `all|day|week|month` enum — prose rewritten + hint to `[all|day|week|month]`.
- **Suite:** new `test/phase33/` (3 files, 14 tests): skill single-source
  (canonical carries frontmatter, `.claude` artifact diff-identical, build step
  reproduces it idempotently); drift-guard passes clean on the real repo, and
  the guard is proven to detect drift by seeding artificial cases (unregistered
  tool, undeclared prompt, the pre-fix cost-saved first-step mismatch, the stale
  `7d|30d|all` hint, an undocumented sheet); planner fallback note (unknown
  ceiling sets it, known ceiling silent, composes with the reasoning-skip note).
  Full suite green: 84 files / 549 tests (was 81 / 535; +3 files, +14 tests);
  typecheck clean; `npm run build` emits `dist` and refreshes the skill artifact.
  No live LM Studio dependency (all static/text/mock).

---

## Phase G — Tier 3 items (staleness, cross-profile share, live VRAM)

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:**
- **G-1 staleness signal.** New pure `stalenessFor` (`src/helpers/staleness.ts`,
  `STALE_AFTER_DAYS = 30`, injectable threshold). `read_registry`'s trimmed
  entries now carry `stale: boolean` + `staleness_note` (informational only) for
  `last_tested` older than the threshold; fresh/never-tested entries stay quiet.
  No auto re-test — that stays a user decision.
- **G-2 cross-profile share (opt-in).** New `share_test_results(profile,
  source_profile, model_id?)` MCP tool + `TestResultStore.copyApprovedResults`
  + `src/helpers/endpointFingerprint.ts` (normalized URL + auth *presence* →
  short opaque hash, never a token or machine-specific string; CLAUDE.md §6).
  Only `approved` rows travel; pending/staged/judged stay with the run owner;
  re-share is idempotent (same run-stamp skipped); different endpoints refuse
  with a structured `endpoint_mismatch`; self-share is `share_self`. Nothing
  auto-finalizes in the target profile — a later regimen/finalize aggregates
  without re-running the model. CLAUDE.md §2 tool list updated.
- **G-3 live-VRAM-aware tier (advisory).** New pure `effectiveGuardrailAdvice`
  (`src/guardrails/advisor.ts`) + `sampleLiveFreeVram` (`src/helpers/liveVram.ts`).
  `runHealthCheck` gains an optional `hardware` context that adds an additive
  `guardrail_tier` to the report (never raises, downgrades with a human reason);
  `system_health_check` and the dashboard `/api/health` pass it. The Phase B
  probe found NO live VRAM surface, so the sampler returns null → static
  machine-spec tier + recorded note; a future probe swaps in behind the same
  seam. Default report shape unchanged when no `hardware` is passed.
- **Gate note (decision-point outcome):** two older suites asserted `overall ===
  "healthy"` through the real host disk (`system_health_check`, `/api/health`);
  the boot drive dropped to 4.77 GB free (< the 5 GB `DISK_LOW_THRESHOLD_GB`),
  so they reported `degraded` — an environment condition, not a Phase G
  regression (Phase 6 covers disk-low deterministically via injected disk). Disk
  was freed to ~9 GB by the operator and the untouched suites passed.
- **Suite:** new `test/phase34/` (3 files, 25 tests): staleness (pure + surfaced
  on `read_registry`, fresh vs over-threshold); endpoint fingerprint (pure) and
  share tool end-to-end (same endpoint shares approved-only, idempotent re-share,
  different endpoint `endpoint_mismatch`, `share_self`, unknown profile);
  health (constrained-VRAM fixture downgrades effective tier with human reason,
  no-source reduces to static + recorded note, no-`hardware` shape unchanged,
  sampler + `system_health_check` advisory integration). Full suite green:
  87 files / 574 tests (was 84 / 549; +3 files, +25 tests); typecheck clean.
  No live LM Studio dependency (all static/text/mock).

---

## Phase R — Regimen acquire/release fix + Vox-Terminus remediation (post-plan)

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:**
- **R-1 regimen acquire/reuse (bug fix, observed live).** During a real regimen
  pass over the 3b-7b models the operator saw the same model load/unload per
  *model pass* (expected: params are chat-level, one load per pass, not per
  test) and — the actual defect — one model stayed loaded and idle all pass
  while a `:2` clone of the same key loaded/unloaded per test. Root cause:
  `runTestRegimen` bypassed `acquireModel`, unconditionally loading (spawning a
  duplicate instance on the same key) and unloading only what *it* loaded in a
  `finally`. Fix: the regimen path now acquires — lists loaded models, reuses a
  resident instance of the target key (never reloads or tears it down), evicts a
  different occupant on a sequential tier to free the single slot (unload-only-
  what-you-loaded guard preserved), and throws a structured `concurrency_limit`
  when at a parallel-tier cap. `src/workflows/runTestRegimen.ts`.
- **R-2 test-gate alignment.** Two older gate suites asserted the pre-fix
  semantics (regimen always owns the slot from scratch). Harnesses now default
  to a fresh endpoint (nothing resident) so the "unload exactly once on every
  path" gate keeps its meaning, with `residentGemma` opt-in for the already-
  loaded case. New Phase 9 gate "regimen acquire/release (no duplicate
  instances)": target resident → 0 loads / 0 unloads (reuse, no `:2`); different
  occupant sequential → evict once + load once + unload own; fresh → 1/1.
- **R-3 dashboard / Vox-Terminus remediation.** Terminal + btw-chat typography
  bump (14px, 1.6 line-height, `--font-term` with IBM Plex Mono first, terminal
  aesthetic kept); user turns now render as `>` inline echo (like real terminal
  input in the chain); new `clear` button in the btw-chat head wipes the stale
  per-profile `/nanites-btw` chat (survives restarts otherwise) and returns the
  panel to live server logs — `POST /api/btw/clear` in `src/ui/server.ts`
  (`btwChat.remove` + `btwChatMessages.deleteAll`; live event tables untouched;
  idempotent). `dist/ui/index.html` + `main.js` rebuilt.
- **R-4 dashboard boot + preview open.** `maybeStartUi()` already fire-and-forgets
  the dashboard on MCP boot (`src/index.ts:33`), once per session. Every slash-
  command sheet now carries a session-boot preamble that opens the dashboard in
  the embedded preview (`nanites-dashboard` launch.json attach at
  `127.0.0.1:4700/#/vox-terminus?maximize=1`) before slash flows run — mirrored
  to the installed plugin copy (10 sheets).
- **Suite:** full suite green — 87 files / 577 tests (was 87 / 574; +3 acquire/
  release tests), typecheck clean, `npm run build` clean. Route verified live
  (`POST /api/btw/clear` → 200 on a running dashboard), new HTML markers present
  in `dist/ui/index.html`. In-app Browser preview disabled on this install, so
  visual checks were headless (DOM markers + route probes), not pixel-level.

---

## Phase R2 — JIT-sibling teardown, dynamic-profile gated (post-plan)

**Status:** ✅ Confirmed
**Date:** 2026-09-04
**Notes:**
- **R2-1 orphan root cause (established live).** After the Phase R regimen run
  on `qwen3.5-0.8b` the operator saw an idle orphan `qwen3.5-0.8b:3` left
  resident. Instrumented teardown (`listModels` on the finally path) showed TWO
  same-key instances resident mid-pass — the explicit load's bare `qwen3.5-0.8b`
  plus a JIT sibling `qwen3.5-0.8b:3` spawned by LM Studio's server-side
  on-the-fly load during a chat. LM Studio treats JIT-triggered models as
  stateless and governs them by its own idle TTL (default 60min); our teardown
  unloaded only the instance id the load returned, so the JIT sibling survived.
  Also established live on THIS install: native `/api/v1/models/load` and
  `/api/v1/chat` reject `ttl` (`unrecognized_keys`, server zod validation);
  OpenAI-compat `/api/v0/chat/completions` accepts it. That steered the split:
  teardown fix now, full TTL redesign (over OpenAI-compat) as a later sprint.
- **R2-2 key-wide teardown, dynamic-gated.** New `unloadModelKey(client,
  modelId)` helper (`src/workflows/runSubAgent.ts`) lists models and unloads
  every instance whose key matches — reclaiming a JIT twin, not just our own id.
  Applied on all three load paths' teardown, gated on
  `profile.dynamic_model !== false`: `runTestRegimen`, `run_sub_agent`
  (`runSubAgent.ts`), and the btw compaction orchestrator
  (`contextCompactionOrchestrator.ts`). Non-dynamic profiles — a user who
  preconfigures resident models and doesn't use dynamic loading — keep the
  legacy own-id-only unload, so their resident models are never torn down.
  Reuse paths (`loaded_this_call false`) still never unload.
- **R2-3 stateful mock harnesses.** `test/phase7/helpers.ts` +
  `test/phase9/helpers.ts` load/unload routes are now stateful: `listModels`
  overlays live resident instances onto the fixture and appends synthetic
  entries for keys absent from it (e.g. `openai/gpt-oss-20b`), so key-wide
  teardown can see what it loaded. `test/phase9/helpers.ts` adds a `jitDuplicate`
  option (fresh load reports `<key>` + `<key>:1` resident) and a `loaded()` probe.
- **R2-4 new gates.** Phase 9 "regimen acquire/release": dynamic profile +
  JIT sibling → 1 load / 2 unloads / `loaded()` empty after (orphan evicted);
  non-dynamic profile (`dynamic_model: false`) + JIT sibling → 1 load / 1 unload
  only, `<key>:1` twin still resident (never tears down the user's model).
  Existing fresh-path gates unchanged (still 1 load / 1 unload on dynamic).
- **Suite:** full suite green — 87 files / 579 tests (was 87 / 577; +2 JIT
  eviction tests), typecheck clean, `npm run build` clean.

---

## Phase T — Per-request TTL over `/v1/chat/completions` (hybrid transport)

**Status:** ✅ Confirmed
**Date:** 2026-09-04

Hybrid transport redesign (plan bubbly-sprouting-whisper.md, T1–T7). On
**dynamic-model profiles** with `inference.ttl_s > 0`, tool-less single-shot
generation (`run_sub_agent` plain, btw compaction map/reduce) now routes over
the OpenAI-compat `/v1/chat/completions` + per-request `ttl` instead of our
explicit load/teardown choreography. Tool-granted, held/QA, toolkit `chat`,
`runTestRegimen`, and all non-dynamic profiles stay on native `/api/v1/chat`.

- **T1 tolerant SSE parse.** `readSseEvents` JSON.parse is non-fatal: blocks
  that fail to parse (`data: [DONE]`, keep-alives) are skipped, not thrown.
- **T2 transport seam.** `LmStudioClient.chat` gained `opts.transport` /
  `opts.ttl_s`; the openai branch translates body (`model` key not instance id,
  string input → messages, `max_output_tokens` → `max_tokens`, passthrough
  `reasoning`/`reasoning_budget`/`context_length`/sampling params) and
  normalizes the OpenAI SSE wire (`\n\n`-delimited, `data: [DONE]`-terminated,
  no `event:` lines) into native `message.delta`/`reasoning.delta` events +
  a synthetic `chat.end` carrying a ChatResponse with stats synthesized from
  OpenAI `usage`. Downstream consumers (cleaner, runaway detector, ledger,
  scorer) never see the wire change.
- **T2a usage chunk.** Live probe proved LM Studio omits `usage` from streams
  unless asked → stream bodies carry `stream_options: { include_usage: true }`;
  without it every synthesized stat logged zeros. Locked by a body-translation
  unit assertion.
- **T2b tps window.** Synthesized tokens-per-second originally divided the full
  completion count (incl. the pre-content reasoning burst) by the content-only
  window → absurd `t_s` live (27k). The rate now spans first-any-token →
  end (`firstTokenAt`), giving sane t_s (live: ~74).
- **T3 config/schema/UI.** Profile `inference.ttl_s?` (0=off native; 30–60
  recommended), zod on create/patch, dashboard profile editor field
  (`cfgTtlS`), UI server `/api/profile` returns it. Live: `/api/profile`
  serves `ttl_s: 45` after the TEST patch.
- **T4/T5 routing.** Predicate decided once per run:
  `dynamic_model !== false && ttl_s > 0 && tool-less && !hold`. Eligible runs
  skip acquire entirely (no load/unload), address the registry key, emit a
  coherent `model_load.end` (`load_ms:null`), leave `metrics.load_ms` null (no
  load penalty). Native branches byte-identical for the ineligible case.
- **T6 gates.** 11 new tests (phase1 transport unit incl. body translation;
  phase8 sub-agent gates a–f: plain→openai 0 loads/unloads, tools-enabled→
  native+integrations, hold→native, ttl_s 0→native, dynamic off→native,
  no-model-for-role; phase32 compaction map+reduce over openai, 0
  load/unload, ttl-bearing bodies, synthesized ledger rows).
- **T7 live probes & E2E** (all against the real TEST profile/LM Studio):
  - P1 ttl honored: `/v1` chat `ttl:15` → auto-evicted within 20s.
  - P2 single JIT instance: 3 sequential same-key `ttl:8` → exactly one
    resident instance, no orphan growth.
  - P3 wire shape: `[DONE]` + `\n\n` + reasoning deltas present; content deltas
    flow when the model isn't starved (probe: `reasoning off` on qwen3.5-2b is
    ignored → thinks through the whole ceiling and replies empty; `reasoning
    low`/`on` + small budget → clean reply).
  - P4 informational: `context_length` 4096→8192 over `/v1` → same resident
    instance id, no forced reload.
  - Live sub-agent (`ttl_s:45`): reply "7", ledger row 135 in / 404 out,
    ttft 5.2s, cost, `load_ms` null, no load/unload, model left warm-resident.
  - Live compaction: 8-turn transcript → 2 chats (map+reduce) over openai,
    both ledger rows `load_ms` null, summarizer left warm-resident, nothing
    unloaded.
  - Tool-loop live attempt: `tools.enabled:true` + real integration
    (`mcp/filesystem` per `~/.lmstudio/mcp.json`). LM Studio returned HTTP 403
    "Permission denied to use plugin 'mcp/filesystem'… if using an API token,
    it has the necessary permissions" — clean structured refusal, no partial
    execution, grant restored. Mechanism executes server-side as designed; the
    block is the LM Studio client toggle ("Allow calling servers from
    mcp.json") being OFF (or the API token lacking the scope). Unit coverage
    intact; user action required to flip the toggle before a live pass.
- **Fix landed during T7.** Reasoning-type learning upserts assumed a registry
  entry existed (`{...existing!}`) — a live explicit-`model_id` run on an
  unregistered key crashed the workflow. Both learning sites (400-retry
  `non_reasoning`, stat-driven `reasoning`) now guard on entry existence.
- **Deployment notes.** TEST now has `inference.ttl_s: 45` + a registered
  qwen3.5-2b entry (`reasoning_type: reasoning`, summarizer role) from the
  live E2E. LM Studio treats `reasoning_budget` as advisory (336 reasoning
  tokens observed despite budget 64) but still emits content when
  `reasoning_type: reasoning` routes `on` + a budget. MCP server process must
  be restarted to load the new dist (UI on 4700 already restarted).
- **Suite:** full suite green — 90 files / 590 tests (was 87 / 579; +11 TTL/
  openai gates), typecheck clean, `npm run build` clean. Out of scope:
  routing the regimen to ttl (needs P4-adjacent calibration proof), defaulting
  `ttl_s` on globally, endpoint widening beyond `/v1/chat/completions`.

---

## Phase CP-0 — Baseline snapshot + isolation (concurrency-hardening workstream)

**Status:** ✅ Confirmed
**Date:** 2026-09-05
**Notes:** Workstream defined in plan
`d-lm-nanites-lms-docs-nanites-btw-spec-enumerated-pillow.md` (concurrency
hardening: per-load num_parallel control + process-capacity × slots tiers).
The prior sprint shipped but was uncommitted in the main checkout; snapshot
committed on `main` as `c3945bc` ("systemic-fixes + btw sprint baseline",
147 files, +14536). Branch `concurrency-hardening` cut off it + fresh worktree.
Baseline suite on the fresh checkout: **96 files / 618 tests — 3 failed**, all
`test/phase33/skillSource` frontmatter/byte-identity asserts. Root cause: repo
had no `.gitattributes` and `core.autocrlf=true`, so fresh checkouts materialize
the LF-stored markdown blobs as CRLF, breaking LF-exact-string tests. Fix
committed: `.gitattributes` `*.md text eol=lf` + LF-normalized the two skill
markdown files; `scripts/copy-skill.mjs` regenerated the artifact; phase33
re-run green (14/14). Full suite now green 96 files / 618 tests.

---

## Phase CP-1 — Live probe: LM Studio num_parallel/parallel acceptance

**Status:** ✅ Confirmed
**Date:** 2026-09-05
**Notes:** Live probe against the real TEST endpoint
(`scripts/live-probe-parallel.mjs`; loads one model per attempt, unloads via
`{instance_id}` — the native unload body key is `instance_id`, not `id`/`key`,
per docs/08 — and verified resident-empty after). Findings gate CP-3's
send-key constant:

| Question | Finding |
|---|---|
| Server default when no param sent | `loaded_instances[].config.parallel = 4` (hypothesis confirmed). |
| Request key `num_parallel` | **Rejected** — HTTP 400 `unrecognized_keys` (native `/api/v1/models/load` zod). |
| Request key `load_config` (nested) | **Rejected** — `unrecognized_keys`. |
| Request key `parallel` | **Accepted** — `{model, parallel: N}` loads an instance whose `config.parallel === N` (round-trips 1/2/4 exactly). |

**Decision:** gate constant `LOAD_NUMPARALLEL_KEY = "parallel"` (CP-3). Nanites
loads send `{ model, context_length?, parallel: profile.concurrency.num_parallel }`.
No load-time `num_parallel` support exists on this build; the `parallel` key is
the mechanism. Default `parallel=4` on unparameterized loads is exactly the
constrained-tier hazard this workstream removes (forces 1 on <12GB profiles).

---

## Phase CP-2 — Tier/advisor/concurrency data layer

**Status:** ✅ Confirmed
**Date:** 2026-09-05
**Notes:** Concurrency is now a *pair* (process capacity × num_parallel slots),
first-class in tiers, advisor, and profiles.

- `src/guardrails/tiers.ts`: each `VRAM_TIERS` row now carries
  `maxParallelModels`/`numParallel` (default pair) + `allowedPairs` (override
  set; empty = forced). Per locked mapping: <6 / 6-12GB forced (1,1), no
  override; 12-24 (high) allowed [(2,2)] default (2,2); 24+ (ultra) allowed
  [(2,2),(4,2),(2,4),(4,4)] default (4,2). Helpers: `defaultPairForVram`,
  `allowedPairsForVram`, `pairAllowedOnTier`, `pairIsSequential`, `pairKey`.
  Existing exports (`tierForVram`, `recommendedMaxParamsB`,
  `contextCeilingForVram`, guardrailFilter guidance) unchanged — additive only.
- `src/guardrails/advisor.ts`: `adviseGuardrails` +
  `effectiveGuardrailAdvice` return additive `num_parallel` + `allowed_pairs`;
  reason strings name the pair and warn `num_parallel=4` multiplies KV-cache
  ~4x when 4-slot combos are allowed. Live-VRAM downgrade path unchanged.
- `src/storage/profileDefaults.ts`: `ConcurrencyConfig` gains required
  `num_parallel` (legacy files accepted — schema marks it optional, read
  backfills). `Profile`/`CreateProfileInput` gain optional persisted
  `concurrency_override`. New pure `validateConcurrencyOverride(vramGb, pair)`
  returns structured `concurrency_override_invalid` for any pair outside the
  tier's allowed set (forced tiers reject even (1,1)). `resolveProfile`
  (create/update write path) throws that error on an invalid override and
  resolves `concurrency` = override-wins-over-derived.
- `src/storage/profileManager.ts`: `readProfileFile` re-derives effective
  concurrency from stored specs + still-valid override, so a hand-edit that
  drifts a profile across VRAM tiers degrades a now-invalid override to the
  tier default (never bricks the read). Toolkit create/update zod schemas
  expose optional `concurrency_override` (incl. null-to-clear).
- Old asserts updated: phase3 profileManager derived concurrency (+num_parallel,
  override null), phase15 profile vram16 concurrency (+num_parallel=2).
- **Suite:** new `test/phase37/` (advisor 8, concurrency 12, profileOverride
  10 = 30 tests) green; full suite green 99 files / 648 tests, typecheck clean,
  `npm run build` clean (phase0 handshake re-run green after build).

---

## Phase CP-3 — Load-path plumbing: send num_parallel (`parallel`) per load

**Status:** ✅ Confirmed
**Date:** 2026-09-05
**Notes:** Every Nanites-initiated native load now carries the profile's
concurrency pair as the CP-1-probed key.

- `src/helpers/concurrency.ts` (new): single gate constant
  `LOAD_NUMPARALLEL_KEY: "parallel" | null = "parallel"` + `concurrencyLoadExtras(numParallel)`
  returning `{ parallel: N }` when the gate is on, `{}` when null (advisory
  fallback — bodies byte-identical to pre-hardening, never a broken load).
- `src/lmstudio/types.ts` `LoadModelRequest` gains optional `parallel`.
- Load-body builders patched: `acquireModel` in
  `src/workflows/runSubAgent.ts` (shared by run_sub_agent, btw held-instance
  `ensureHeldInstance`, and context-compaction orchestrator — all three route
  through it) and run_test_regimen's `ensureContext`. A forced sequential
  profile therefore loads every resident instance with `parallel: 1`.
- `load_model` (toolkit) gains optional `params.num_parallel`; defaults to the
  active profile's tier pair when omitted, and validates an explicit value
  against the tier's allowed slots (`concurrency_override_invalid` outside;
  forced tiers allow only 1).
- **Suite:** new `test/phase37/loadbody.test.ts` (11) + `nullgate.test.ts` (2)
  green; phase7 regimen harness gained an additive `lastLoad` getter. Full suite
  green 101 files / 661 tests, typecheck clean, `npm run build` clean.

---

## Phase CP-5 — Health, UI/dashboard, copy (the pair everywhere)

**Status:** ✅ Confirmed
**Date:** 2026-09-05
**Notes:** Pairs surface at every boundary, and the dashboard profile editor
becomes the real override surface (the dead `#cfgTier` select is gone).

- `src/ui/server.ts:343-358` `handleHealth`: `hardware` payload additively
  carries `process_cap`, `num_parallel`, `allowed_pairs`, `overridden`. Phase 14
  test updated to assert the full new shape.
- `src/ui/server.ts:361-385` `buildProfilesResponse`: each profile also carries
  the resolved `concurrency` pair, `allowed_pairs`, and `overridden` flag, so
  the 9:16 profile cards and the dropdown show the pair at a glance.
- `src/ui/server.ts:387-415` `handleProfile` mirrors the same fields on
  `GET /api/profile?name=` (the editor's source of truth) and returns
  `concurrency_override` for round-trip display.
- `src/ui/server.ts:746-770` router catch: domain errors (incl.
  `concurrency_override_invalid`) now map to 400 / 503 by `retryable`, not the
  catch-all 500 — invalid overrides surface to the dashboard as 400 with the
  structured `code`.
- `src/helpers/systemPromptPlanner.ts:46` drops the hardcoded "single-model"
  phrase and uses the resolved pair (`sequential 1x1, one inference at a time`
  or `parallel {pc}x{slots}`); its `concurrency` type gains `num_parallel`.
  `test/phase25/system-prompt.test.ts` updated + a new test pins the parallel
  phrasing and asserts "single-model" never appears.
- `frontend/nanites-dashboard.html`: `#cfgTier` is now a real concurrency-pair
  picker — `Auto (from specs)` plus one option per allowed pair, options
  re-populated on profile load and on `#cfgVram` change. The save patch carries
  `concurrency_override` (null clears it). Hardware panel: `#hwTier` shows the
  resolved pair with `(auto)` / `(override)` suffix, and `#hwGuardNote` calls
  out the KV-cache ×N cost on 4-slot combos. Profile cards show the pair and
  `OVERRIDE` flag. New `renderTierOptions` / `allowedConcurrencyPairs` /
  `pairKeyOf` helpers; `#cfgVram` change re-renders the picker.
- `frontend/DASHBOARD_HANDOFF.md` §"Settings" updated to document the new
  control's contract (option keys = `maxxnum`, save sends `concurrency_override`,
  server re-validates).
- `CLAUDE.md` §3 profile JSON: `concurrency.num_parallel` + the new
  `concurrency_override` field documented. §4 table rewritten: pairs +
  allowed-pair column + the override/slot policy, with the advisor reason
  example updated.
- Canonical skill `plugin/nanites/skills/nanites/SKILL.md` and command sheet
  `plugin/nanites/commands/nanites-new-profile.md` retitled to match the new
  tier wording; phase33 drift-guard still green (14/14).
- **Suite:** new `test/phase37/ui.test.ts` (4): patch round-trips 2x2 on a 16GB
  profile and reflects on /api/profile + /api/health with overridden flag set;
  4GB forced-tier override rejected with `concurrency_override_invalid` and
  never persists; clearing an override on a 24GB ultra profile returns to the
  derived 4x2 default; served dashboard HTML carries the new control markers.
  Updated `test/phase14/server.test.ts` health-hardware assert to the new
  full shape, `test/phase25/system-prompt.test.ts` to the new phrasing. Full
  suite green 103 files / 671 tests, typecheck clean, `npm run build` clean.

---

## Phase CP-6 — Full validation + GATELOG close

**Status:** ✅ Confirmed
**Date:** 2026-09-05
**Notes:** End-of-sprint validation.

- Typecheck `tsc --noEmit` clean. `npm run build` clean (refreshes
  `dist/ui/index.html` and the `.claude/skills/nanites/SKILL.md` copy from
  `plugin/nanites/skills/nanites/SKILL.md`).
- Full suite green: **103 files / 671 passed** (baseline was 90 files / 590
  tests; +13 files / +81 tests across CP-1..CP-5, including the phase33
  drift-guard at 14/14).
- `git status` clean aside from the build-generated
  `.claude/skills/nanites/SKILL.md` copy, which is committed in lock-step with
  the plugin source (commit 288d1a8).

---

## Phase CP-4 — Sequential serialization gate (shared mutex)

**Status:** ✅ Confirmed
**Date:** 2026-09-05
**Notes:** At most one in-flight inference per sequential-tier profile even when
callers overlap — the server slot (`parallel: 1`, CP-3) alone was never the
guarantee; the mutex is.

- `src/helpers/inferenceGate.ts` (new): module-singleton per-profile async mutex
  (promise-chain acquire/release, keyed by profile name) + `resetInferenceGates`
  test seam. Parallel tiers never call it — their bounded fan-out is the pool.
- `src/workflows/runSubAgent.ts`: after `pool.tryAcquire()` success, a
  sequential profile awaits `acquireInferenceSlot(profileName)` before any
  acquire/load/chat/stream work, and releases in the big `finally` right after
  `pool.release()` — so the whole run (model acquire → chat → teardown → log)
  is the critical section. Gate sits before the offMode/ttl/openai transport
  branches, so a sequential profile never has two live chats regardless of
  transport. Parallel tiers keep bounded concurrent runs.
- run_test_regimen / btw / context-compaction were deliberately NOT wrapped:
  their loads already route through `acquireModel` (CP-3 slot=1), and wrapping
  btw + compaction would risk self-deadlock (compaction nests inside a btw turn
  on the same gate).
- `test/phase8/helpers.ts` gained an additive `openAiDelayMs` option (the
  openai/ttl transport's mirror of `chatDelayMs`) so the ttl path can be
  exercised under a real time budget.
- **Suite:** new `test/phase37/mutex.test.ts` (5): gate ordering unit; two
  concurrent blocking `run_sub_agent` calls on a sequential profile serialize on
  both native (2 clean sequential load/chat cycles, never a double-load race)
  and ttl transports (~1s for two 400ms chats); a high (2x2) profile runs the
  same two calls overlapped (~550ms) on both transports — the gate does not
  apply to parallel tiers. Full suite green 102 files / 666 tests, typecheck
  clean, `npm run build` clean.

---

<!-- One "## Phase <id>" section is appended here at each confirmed gate, in
order. Format: Status (✅ Confirmed / ⛔ Blocked), Date, Notes (what shipped,
what the live probe decided, any decision-point outcomes, suite result). -->

---

## Phase P — Provider Key Vault + Model Registry UI Overhaul

**Status:** ✅ Confirmed
**Date:** 2026-09-07
**Notes:** Overhauled the Provider Key Vault and Model Registry panels in the dashboard
to support manual model registration, API key testing, and persistent nicknames.

### What shipped
- **Backend fixes & extensions:**
  - Discovery returns `{code:"no_keys_configured"}` instead of HTTP 400 error (neutral message in UI)
  - Nickname columns added to `provider_api_keys` and `provider_models` tables (migrations v15/v16)
  - New endpoint `POST /api/providers/keys/test` — pings provider `/models` to verify key works
  - New endpoint `PATCH /api/providers/keys/nickname` — update key nickname
  - New endpoint `PATCH /api/providers/models/nickname` — update model nickname
  - All store read/write methods updated to surface nickname field
- **Key Vault panel:**
  - Nickname field added to add-key form
  - "Test Key" button per saved key (calls `/api/providers/keys/test`)
  - Visual confirmation message on add/delete
  - Neutral "no keys configured" empty state
- **Model Registry panel:**
  - Manual model registration form: provider picker + nickname + model ID input + Test + Add Model buttons
  - "Test Model" button on registered models (existing)
  - Neutral "no registered models" empty state updated to mention manual add
  - Nicknames displayed inline in model list
- **Bug fixed:** Discovery error was showing red error for empty key state — now neutral gray

### Decisions made
- Nicknames are frontend-persisted (stored in DB, survive frontend restart)
- Key test scope: Option A (simple `/models` endpoint ping, not inference)
- Discovery with no keys: neutral message, not red error

### Suite
New tests in `test/phase38/plugin.test.ts`: handles provider keys with nicknames,
handles model registration with nicknames, serves key test endpoint, discovery
returns no_keys_configured when no keys exist. Full suite: **703 tests green**, typecheck clean.

---

## Sprint — Model Pinning + Vision (registered 2026-09-10)

**Branch:** `feat/model-pinning-vision-sprint` (base: `fix/cloud-fs-tool-parity` @9604cc5 — its CF
parity PR merges first).
**Plan doc:** docs/34_Model_Pinning_and_Vision_Sprint.md.
**Scope:** per-role preferred-model pins w/ auto-route + fallback ladder; merged local+cloud role
leaderboard (cloud rows scored via a new cloud regimen path); bulk-seed of the 13 CF agentic
models (+ llama-3.2-11b-vision) w/ roles + default pins; vision analysis (chat-completions
image parts, `run_sub_agent` images[]); `/nanites-vision` profile flag + slash; 11th built-in
role `vision`.
**Decisions:** pins keyed by open-ended role, store provider+model (D1-D4 doc §2); `vision_capable`
per-profile flag default true; vision analysis-only v1 (gen/editing deferred — non-chat `/ai/run`);
seed ids validated against live CF catalog, never blind-inserted; claims filed separately in
docs/35_Sweep_Findings_Verified.md (NOT queued into this sprint).
**Phases Q0-Q7** appended below as each gate confirms (✅/⛔ + live-probe outcomes).
Read-only sweep findings (read-only request, pre-sprint): docs/35.


---

## Phase Q0 — Ground Truth (catalog + vision-capability probe)

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
- Live CF catalog probe via the MCP discovery path + a direct read of the real catalog DB
  (`node:sqlite`, server-side, no key material touched/persisted). Discovery had cached 67 CF
  models; the tool display trims to 20 and drops capabilities, so ground truth came from a
  direct DB read of `provider_models` + a CF docs capability enumeration.
- **Finding:** CF `/ai/models/search` returns **no** capability/modality data — every catalog
  row, including `llama-3.2-11b-vision-instruct`, came back `capabilities.vision:false`,
  `supported_modalities:["text"]`. Per-model vision/FC/context must come from CF docs pages.
- All **14 manifest ids resolve** to real catalog entries (the 13 agentic + llama-3.2-11b-vision).
  No id failed resolution; no replacement/refusal needed.
- Capability ground truth (CF docs, cross-checked mastra + crackedaiengineering):
  - Vision-capable (5): `gemma-4-26b-a4b-it`, `qwen3.8-27b`, `mistral-small-3.1-24b-instruct`,
    `llama-4-scout-17b-16e-instruct`, `llama-3.2-11b-vision-instruct`.
  - Function-calling confirmed on 11 of 13 agentic models; `deepseek-r1-distill-qwen-32b` +
    `qwq-32b` are reasoning-only (T3) — matches the source tier list.
- **Decision (id/capability pivot):** `mistral-small-3.1-24b-instruct` is vision-capable —
  docs/34 §3 assumed 3-of-13 vision. It now joins the vision pool (role tag `vision` added).
  docs/34 §3 + manifest updated accordingly.
- Emitted `src/seed/cloudflareAgentManifest.ts` — canonical manifest: 14 entries, each with
  `model_id`, tier, roles, `vision`, `function_calling`, `context_length`, plus
  `VISION_CAPABLE_MODELS` + `CLOUDFLARE_DEFAULT_PINS` (7 pins: code_writer/refactorer/code_qa/
  test_writer→gpt-oss-120b, doc_writer→nemotron-3-120b-a12b, reviewer→glm-4.7-flash,
  vision→gemma-4-26b-a4b-it).

### Suite
`test/phase40/cloudflareAgentManifest.test.ts` (+ `catalogFixture.ts` snapshot): **12 tests green**
— every manifest id resolves to the catalog; vision flags agree with catalog (no text-only model
claims vision, every vision model carries the vision role); default pins unique + resolvable +
registered; vision role covered by ≥1 vision-capable model with fallback depth beyond the pin.

---

## Phase Q1 — Data layer + role vocabulary

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
- **Migration v17** (`src/storage/migrations.ts`): nullable `model_registry.provider`
  (NULL = local LM Studio key; else cloud kind) added idempotently in `applyMigrations`
  (mirrors v14-16 guard pattern); new `role_pins` table PK `(profile_name, role)` with
  `provider`, `model_id`, `updated_at`.
- **RolePinStore** (`src/storage/rolePinStore.ts`): set/get/list/remove per profile;
  `PIN_PROVIDERS` = local + 4 cloud kinds; `set` rejects a provider outside the enum with a
  structured `invalid_arguments` error.
- **RegistryStore provider round-trip**: upsert/get/list carry `provider`; new `listLocal()`
  (provider IS NULL) — local selection consumers swapped to it (`runSubAgent` both local
  branches, `btwChat`, `contextCompactionOrchestrator`) so a future cloud registry row can
  never win a local LM Studio pick and leak into a load id. `backfillScores` preserves
  provider via entry spread. `write_registry_entry` accepts + preserves provider.
- **Profile `vision_capable`** (default `true`, docs/34 D10): `Profile` + `CreateProfileInput`
  + `resolveProfile` + `profileSchema` (optional on read) + `readProfileFile` default-fill +
  `profilePatchSchema` + toolkit create/update zod.
- **`vision` 11th built-in role** (`roleMatch.ts`): `ROLE_KEYWORDS.vision` (image/diagram/
  screenshot/ocr/visual/photo/figure/caption keywords); `BUILT_IN_ROLES` auto-grows to 11;
  roleVocabulary (built-ins ∪ registered custom unit roles) includes it.

### Suite
`test/phase41/dataLayer.test.ts`: **10 tests green** — v16→v17 legacy upgrade (provider col +
role_pins) + fresh-DB version 17; registry provider round-trip + listLocal exclusion (a higher
scoring cloud row never leaks into local selection); pin CRUD + profile isolation + local
accepted / invalid provider rejected; `vision_capable` default true, update persists to disk,
legacy file reads true; `vision` is the 11th built-in role + test-unit validator accepts it.
Typecheck clean.

---

## Phase Q2 — Pin-aware resolution rewired into run_sub_agent

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
- **`src/workflows/resolveRoleModel.ts`** — pure pin-aware resolution (docs/34 D1-D4). Reads
  only the registry / key / model / pin stores; never touches a provider or LM Studio.
  Precedence ladder:
  1. Explicit `model_id`/`provider` win (byte-identical to pre-sprint for explicit local model).
  2. Explicit provider only → honored only if a matching pin sits on that same provider and is
     usable; else dynamic within the explicit provider.
  3. No explicit args → first requested role (or brief-keyword role) with a pin auto-routes to
     the pin's provider; local pin requires a registry entry, cloud pin requires a usable
     (enabled + non-exhausted) key **and** a registered provider model.
  4. Unavailable pin → `pin_fallback_dynamic` within the pin's own provider (model null).
  5. Full provider outage → `cross_endpoint`: first later enabled provider in
     `provider_preference_order` with a usable key + a registered model. Local is **never** a
     cross target (a cloud outage never silently redirects to LM Studio).
  6. Nothing usable anywhere → structured `no_model_for_role`.
  Every pivot carries a human-readable `note`.
- **`runSubAgent` rewire** — profile fetch + `resolveRoleModel` moved before the health gate;
  the LMS health gate now runs only when resolution is `local`. Cloud branch condition is
  `resolution.provider !== "local"`; resolved `provider`/`model_id` thread into
  `routeCloudWithRetry` / `runCloudToolLoop` (null → undefined = router decides). A
  `resolution` event fires per run; the resolution note surfaces on the result `note`
  (cloud + local) alongside the planner/confidence notes. `run_sub_agent` callers passing an
  explicit provider/model see behavior identical to today; missing-pin, no-args runs resolve
  to local dynamic exactly as before.

### Suite
`test/phase42/roleResolution.test.ts`: **16 tests green** — default no-pin → local dynamic;
explicit model (bare / provider'd) beats pins; explicit provider suppresses a pin on another
provider; local pin honored only with a registry entry (else pin_fallback_dynamic); cloud pin
auto-routes with key+registered model; brief keywords auto-route through the vision pin; pin
order (first requested role with a pin wins); explicit-provider + usable same-provider pin →
pin; cloud pin with key but unregistered model → dynamic within provider; pin-provider outage
→ cross_endpoint; explicit-provider outage → cross_endpoint; all exhausted → structured
`no_model_for_role`; disabled-provider pref never silently redirects to local.

### Regression
Full suite re-run after the rewire: **107 files / 745 tests green** (no provider-free local
default changed shape) + phase42's 16. Typecheck clean.

---

## Phase Q3 — Cloud regimen + merged leaderboard (docs/34 Phase 3, steps 1–4)

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
- **Migration v18** — `test_results.provider` (`src/storage/migrations.ts`, guarded
  `ALTER ... ADD COLUMN` branch). Cloud regimen inserts stamp their provider kind so
  the unchanged (provider-less) `submit_test_judgment` path still finalizes a
  provider-tagged registry entry. A real DB reaching v18 always passed through v11
  (which created `test_results`), so the ALTER needs no existence guard — the
  column-add itself is the idempotent guard. `testResultStore` thread the provider
  through `insert`, `copyApprovedResults` (share copies the stamp, preserving the
  candidate column), and `rowToResult`.
- **`finalize.ts`** — `finalizeIfComplete(deps, profile, model, provider?)` tags the
  registry entry. The provider is resolved from the explicit arg, else the first
  non-null row stamp, else the entry's existing provider — so a cloud regimen run
  and a legacy provider-less submit both land the same tagged entry. Local rows
  stay provider-null.
- **`runTestRegimen` cloud pass** (`runCloudRegimen`) — dispatch near the top, after
  the profile fetch: `provider` given and ≠ `local` → cloud regimen; otherwise the
  local LM Studio pass is byte-identical to pre-sprint. The cloud pass routes every
  per-unit chat through a `cloudChat` seam (default: `routeCloudWithRetry`, which
  already logs provider_call_logs cost per attempt). No load/unload, no
  ensureContext, no clamp — cloud models can't hold a local slot. Deterministic
  units score under both param candidates (params derived via
  `paramsForCandidate(unit.recommended_config, candidate)`), judged units stage
  baseline pending + variant staged with the provider stamped; empty replies retry
  once then abort; per-model ntfy pushes carry `via ${provider}`; result summary is
  shape-identical to the local one (`deterministic_scored`, `pending_unit_ids`,
  `param_attempts`, `clamped_units: []`).
- **`toolkit.ts`** — `run_test_regimen` accepts an optional `provider` enum
  (`cloudflare|openrouter|omniroute|generic`); when set the tool hands it to the
  regimen. Default unchanged → local.
- **Merged leaderboard** (`ui/server.ts` `handleLeaderboard`) — `view=all` mixes
  local + cloud registry rows, `view=local|cloud` filters. `role=all` orders by
  `performance_score` (nulls last, cloud rows that only hold per-role scores sink
  below scored locals); a specific role filters to entries carrying that role and
  orders by its real score. Registered-but-untested cloud models (provider catalog,
  no registry entry) render as null-score rows. Existing phase14 shape preserved:
  `{model, provider, score, score_minima, params, tested}`.

### Suite
`test/phase43/cloudRegimen.test.ts`: **5 tests green** — migration v18 on a fresh
DB and a legacy v17 DB (idempotent re-apply); cloud deterministic regimen row
shapes match local and finalize writes a cloudflare-tagged entry while `listLocal`
never sees the cloud model; cloud judged flow stamps pending/staged rows and two
provider-less submits finalize a provider-tagged entry whose score collapses to the
winner (variant 92 > baseline 88); merged leaderboard mixes/orders/views correctly
with null scores for registered-but-untested cloud rows and the 11th role `vision`
filtering. `test/phase41/dataLayer.test.ts` bumped from hardcoded 17 to
`MIGRATIONS.length` and its legacy v16 fixture gained the real `test_results` table
(any v16 DB holds it from v11), so the v16 → current chain exercises v17 and v18.

### Regression
Full suite: **109 files / 766 tests green**. Typecheck clean.
## Phase Q4 — Seed/pin tools, slash commands, and SKILL claims (docs/34 Phase 4)

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
- **`src/storage/providerModelStore.ts`** — `registerManifestModel(profile, provider, spec)`,
  a capability-preserving catalog upsert. The CF discover API returns no capability flags,
  so a plain `registerModel` would mislabel every vision model (D6). The manifest seam writes
  `capabilities.vision` / `function_calling` and `supported_modalities` (`image` when vision)
  from the spec, sets `is_registered=1`, and on conflict refreshes name/owned_by/context/caps
  without touching a user nickname.
- **`src/seed/cloudflareAgentManifest.ts`** — canonical manifest (`CLOUDFLARE_AGENT_MANIFEST`,
  14 models incl. `llama-3.2-11b-vision`; role set, vision/FC flags, context length) and the
  7 default role pins (`CLOUDFLARE_DEFAULT_PINS`: code_writer/refactorer/code_qa/test_writer →
  gpt-oss-120b, doc_writer → nemotron-3-120b, reviewer → glm-4.7-flash, vision →
  gemma-4-26b-a4b-it).
- **`src/workflows/seedProviderModels.ts`** — `seedProviderModels` + pin CRUD. Seed is
  deterministic and idempotent: registers every manifest model, role-tags registry rows **only
  as untested placeholders** (`scores: {}`, `last_tested: null`, provider stamped) — a tested
  entry's real scores are never clobbered (reported under `role_tags_tested_kept`), and a
  placeholder already carrying identical roles is not re-written on re-seed. Default pins are
  written only for roles that carry none (custom pins preserved, listed in
  `default_pins_preserved`). Refusals before any write (D11): unknown ids →
  `unknown_manifest_model`, non-cloudflare provider → `no_seed_manifest_for_provider`.
  Registry rows never leak into local selection (`listLocal` clean). No API-key material (D12).
- **`src/tools/toolkit.ts`** — `seed_provider_models`, `set_role_pin`, `list_role_pins`,
  `delete_role_pin` (strict provider enum `local|cloudflare|openrouter|omniroute|generic`;
  bad provider rejected at the schema layer), registered + UI_PLAN-decorated under the
  providers view.
- **Slash surface** — `nanites-seed-agents`, `nanites-pin [list|set|delete] …`,
  `nanites-vision [on|off]` prompts (`src/server/prompts.ts`), command sheets
  (`plugin/nanites/commands/*.md`, first step `get_active_profile`), and three
  `COMMAND_SHEETS` entries — the drift guard's declared surface matches the registered
  tools/prompts exactly.
- **SKILL** (`plugin/nanites/skills/nanites/SKILL.md` canonical) — new "Preferred-model pins,
  cloud routing, and vision" section: pin semantics + fallback ladder (same-provider
  fallback, only a full provider outage crosses providers; a cloud run never drops to LM
  Studio, a local pin never hops cloud), bulk-seed idempotency, vision analysis-only
  cloud-only tool-less delegation gated by the `vision_capable` profile flag. `.claude`
  artifact re-synced via `scripts/copy-skill.mjs`.

### Suite
`test/phase44/seedPins.test.ts`: **11 tests green** — manifest seam writes vision→image
modality + FC caps and keeps a nickname across re-seed; full seed registers all 14, role-tags
14 cloudflare placeholders (scores empty, roles incl `vision` on the vision models), writes
the 7 default pins; re-seed is idempotent (14 already-registered, no dupes, pins preserved,
no placeholder rewrite); a tested registry entry survives re-seed (`role_tags_tested_kept`);
a custom pin set before a full re-seed is preserved and nothing default overwrites it;
unknown id refused pre-write; non-cloudflare provider refused; bad pin provider rejected at
the schema layer; list/set/delete round-trip; `checkNanitesSurface()` clean; canonical skill
carries the vision/pin/seed rules.

### Regression
Full suite: **110 files / 777 tests green** (+phase44, +11). Typecheck clean.
## Phase Q5 — Vision wire (docs/34 Phase 5)

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
- **Content-part typing** (`src/providers/types.ts`) — `ChatMessage.content` widened from
  `string` to `string | ContentPart[]` (`TextContentPart` / `ImageUrlContentPart` with the
  OpenAI `image_url` wire shape). Every provider request is serialized by the one
  `serializeChatRequest`/`toWireMessages` path, which passes string content through and
  carries parts arrays unchanged — all four clients (Cloudflare/OpenRouter/OmniRoute/generic)
  speak the same OpenAI-compat content format, so no per-client image handling is needed.
  Tool-loop history stays text-safe: the fs loop and image runs are mutually exclusive, so no
  image part ever enters a tool round.
- **Image input resolution** (`src/providers/vision.ts`) — `resolveImageUris` turns each
  `images[]` element into a wire URL: local path → base64 `data:` URI with the mime from the
  extension (bounded by a 20MB cap, `MAX_IMAGE_BYTES`), `http(s)` URL and `data:` URI pass
  through. Exact structured refusals: unknown scheme → `unsupported_image_source`, missing
  file → `image_not_found`, oversize → `image_too_large`. `buildVisionContent` composes the
  user message (brief text part — a fallback line when the brief is blank — then one
  `image_url` part per image).
- **Vision resolution** (`src/workflows/resolveRoleModel.ts`) — `resolveVisionModel` runs
  when `ResolveInput.vision` is true. Cloud-only: explicit local provider → `vision_local_not_supported`;
  an explicit vision `model_id` without a cloud provider → `vision_requires_cloud_provider`
  (image runs never default to local). Otherwise the `vision` role pin wins; an unusable pin
  falls back to the best registered vision-capable model on the same provider
  (`pin_fallback_dynamic`); with no pin it auto-picks across enabled providers in preference
  order, best `performance_score` first (`dynamic_cloud`, concrete model). Nothing usable →
  `no_vision_model_registered`. Normal (non-vision) resolution is byte-identical — the vision
  branch returns before the pin ladder.
- **`run_sub_agent` `images[]` param** (`src/workflows/runSubAgent.ts` + toolkit schema) —
  each element a local path / `http(s)` URL / `data:` URI. Presence forces the `vision` role
  and the cloud-only vision ladder; the cloud tool-less path sends
  `buildVisionContent(brief, uris)` as the user message. `images` + an fs tool-loop grant →
  `vision_with_tool_loop` (rejected before any file read). The planner treats the run as
  normal cloud text — reasoning still follows effort/role, and the `vision` role carries no
  forced-reasoning difficulty.

### Suite
`test/phase45/visionWire.test.ts`: **16 tests green** — content-part wire via
`serializeChatRequest` (image_url parts with data-URI + http URL; system/assistant/tool turns
stay string, no image in tool history); `buildVisionContent` text-first; local-path →
`data:image/png;base64,…` round-trip with URL/data pass-through; exact refusals for unknown
scheme / missing / oversized; vision resolution auto-pick (higher `performance_score` wins),
pin honored, pin fallback, and every rejection code; `run_sub_agent` refuses explicit-local
images and images+fs-loop combos; a cloud vision run (stubbed fetch) routes to the registered
vision model, sends the image data-URI on the wire, and advertises no tools.

### Regression
Full suite: **111 files / 793 tests green** (+phase45, +16). Typecheck clean.

## Phase Q6 — Dashboard pins + vision toggle (docs/34 Phase 6)

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
- **`/api/pins` CRUD** (`src/ui/server.ts`) — GET lists the active profile's pins
  `{profile, pins:[{role, provider, model_id, updated_at}]}`; POST `{role, provider,
  model_id}` insert-or-replace (response carries `replaced`); DELETE `?role=<r>` removes.
  Reuses `RolePinStore` directly, so an out-of-enum provider surfaces the store's
  `invalid_arguments` (→ 400), and missing role/model is `bad_request`. One pin per role
  per profile — the dashboard mirrors the MCP `set_role_pin`/`list_role_pins`/
  `delete_role_pin` surface.
- **`/api/roles`** — the dashboard role-vocabulary endpoint: `builtin` = the eleven
  BUILT_IN_ROLES (incl. `vision`), `custom` = roles from the profile's registered test
  units, and `roles` = sorted per-role rows with `kind` + `count`. Counts come from the
  merged model universe (registry `roles` plus registered-but-untested vision-capable
  cloud catalog models), so tab counts match leaderboard rows. Zero-count custom roles
  stay vocabulary-only.
- **Leaderboard `?role=vision` merge** — `handleLeaderboard` now appends
  registered-but-untested **vision-capable** cloud models (provider catalog row, no
  registry entry) under the `role=vision` filter with a null score, matching how they
  already surface under `role=all`. Only `vision` is inferable from a bare catalog row
  (from `capabilities.vision`) — other roles still live on registry entries. Leaderboard
  rows also gained a `model_id` field (untested rows display `name` but pin/route by id).
- **Provider models table enrichment** — `GET /api/providers/models` rows now carry
  `roles` (from the registry entry) and `vision` (catalog `capabilities.vision`), so the
  providers table can render role chips + a vision badge even before a registry entry
  exists.
- **`vision_capable` profile surface** — `GET /api/profile` now returns the profile's
  `vision_capable` flag (the D10 profile field, already patchable via
  `/api/settings/profile` / `update_profile`); backend round-trip tested end-to-end.
- **Dashboard SPA** (`frontend/nanites-dashboard.html`) — leaderboard role tabs build
  dynamically from `/api/roles` (All-Time + counted roles with a count badge); table
  gained Provider + Pin columns; per-row Pin/Unpin buttons toggle the active role's pin
  through `/api/pins` (event-delegated, HTML-safe data attributes); Profile Editor gained
  a **Vision capable** switch (`cfgVisionCapable`) wired into load + save; the providers
  models table shows registry role chips and a purple `vision` badge.

### Suite
`test/phase46/dashboardPins.test.ts`: **7 tests green** — pins CRUD round-trip (empty,
set/replaced, overwrite, delete, invalid provider → `invalid_arguments`, missing fields →
`bad_request`); `/api/roles` vocabulary (eleven built-ins incl. `vision`, custom unit role
`transcriber`, registry + untested-catalog row counts, zero-count roles vocabulary-only);
`?role=vision` merged rows (registry row + registered-but-untested vision model appear with
null score; a non-vision registered model never leaks in); `vision_capable` default-true
surfaces on GET `/api/profile` and round-trips off/on through `/api/settings/profile`; the
served dashboard HTML carries the Phase 6 control markers (vision toggle id + load/save
wiring, `renderRoleTabs` + `/api/roles`, `/api/pins` + `button[data-role]`, provider
`m.roles`/`m.vision`/`visionChip`). Note: the DOM-presence test reads the built
`dist/ui/index.html` (loadIndexHtml prefers it over the frontend source), so a build must
precede it — the full gate runs build → test.

### Regression
Sprint + UI suites: **26 files / 210 tests green** across phase40–46, phase37, phase32,
phase35, phase38. Typecheck clean; `npm run build` clean.

## Phase Q7 — Close-out + full regression (docs/34 Phase 7)

**Status:** ✅ Confirmed
**Date:** 2026-09-10

### What shipped
Sprint close-out across docs/34 Phases 0–6. All phases recorded above (Q0–Q6) each
landed behind their own gate suite (`test/phase40`…`test/phase46`); Q7 is the standing
full regression + clean build, with no new feature code.

### Live-probe decisions (recorded for the record)
Phase Q0's catalog probe and Phase Q5's vision wire were the sprint's two live-touching
decisions; their resolutions (manifest ids, vision-capable pool incl. the
`mistral-small-3.1-24b-instruct` correction, and the OpenAI-compat content-part wire)
are recorded in the Q0 and Q5 entries above. No provider API-key material was ever
persisted or logged by any phase.

### Regression
Full suite: **112 files / 800 tests green** (includes phase39 cloud-fs tool loop,
phase32–35 btw/compaction, phase14–26 online-provider, and every phase40–46 sprint
suite). `npm run typecheck` clean; `npm run build` clean.
