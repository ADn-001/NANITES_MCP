---
name: nanites
description: >
  Delegate bounded, disposable grunt work to local LM Studio models or cloud provider models
  (Cloudflare/OpenRouter/OmniRoute/generic) via the Nanites MCP server — pick sub-agents by role
  pin or registry score, read registry/judgment results, run test regimens, bulk-seed the
  Cloudflare agentic fleet, and weigh performance_score so you spend paid frontier tokens only on
  what needs frontier judgment. Also covers vision delegation to vision-capable models (image
  analysis). Use when the user asks to offload work to local/cloud models, spin up a Nanites
  sub-agent, set a preferred-model pin, seed agentic models, test/register models, or see what a
  local model is good at.
---

# Nanites — Delegation to Local Models

Nanites is an MCP server that lets you drive a local LM Studio instance and
delegate bounded, disposable sub-agent work to local models. You stay the
orchestrator on a paid frontier model; Nanites is the delegation mechanism.
This skill covers the *inference-heavy* judgment calls — when to delegate,
what to delegate, and how to read the results. Deterministic script-chains
(profile CRUD, cost reports, downloads, sweeps) are `/nanites-...` slash
commands / MCP prompts; do not re-derive what they already compute.

## Session start

1. Call `get_first_run_status`. If `needs_first_run` is true, run the
   `/nanites-new-profile` flow now (conversationally, matching its fields)
   before anything else — nothing works without a profile.
2. Call `system_health_check` on the active profile. If the endpoint is down,
   stop and tell the user rather than starting a workflow that will fail
   mid-run.

## Opening the dashboard

Mapped tool results (run_sub_agent / run_test_regimen / registry, profile,
model, cost, health, sweep + download tools) carry a `dashboard_url` when the
dashboard was (lazily) started. **Open that URL in the embedded preview pane**
— the `/nanites-btw` deep-link pattern — never an external browser. The
fragment picks the view (`#/vox-terminus` Live, `#/registry`, `#/hardware`,
`#/cost`, `#/health`, `#/settings`). `dashboard_action:"navigate"` = open it;
`"navigate+reload"` = open even if already showing — a fresh `r` nonce in the
URL makes the SPA reload once, so profile mutations/registry writes reflect on
screen. Absent a `dashboard_url` field, do nothing (some views only open once
per session, or the dashboard is opted out).

## When to delegate vs. do it yourself

Delegate to a local model when **all** of these hold:

- The work is bounded: a self-contained input, a small, well-defined output
  shape, and no need to see your full context or tool history.
- It is disposable: a wrong or mediocre answer is cheap to redo.
- It is grunt work: summarization, classification, extraction, boilerplate
  drafting, code QA against a known rubric — the kind of thing that spends
  paid tokens and context without needing frontier judgment.

Do **not** delegate when:

- The task needs deep reasoning, multi-step planning, or your conversation
  context — the frontier model should just do that inline.
- The answer must be exact and verifiable by a script. If a script can check
  it (exact label, valid JSON, regex), prefer `run_test_regimen`'s
  deterministic units over a sub-agent, and prefer a script over either.
- The result feeds directly into a decision you cannot cheaply redo.

When unsure, ask: "would a wrong answer here cost more to catch than the
tokens saved?" If yes, do it yourself.

## Picking a sub-agent

Decide the role(s) the task needs (`classifier`, `reviewer`, `extractor`,
`code_qa`, `summarizer`, `test_writer`, `doc_writer`, `refactorer`,
`commit_writer`, `code_writer`). Then call `run_sub_agent` with `profile`,
`brief`, and either `roles` or an explicit `model_id`.

- You choose the role, the model, and write the brief. You do **not** choose
  model params — the inference planner owns `reasoning`, `max_output_tokens`,
  `context_length`, and the generation timeout, driven by the profile's
  `effort`. `run_sub_agent` no longer accepts `reasoning`/`max_output_tokens`;
  pass them and the tool rejects the call.
- `effort` is a **user knob**, not a per-call judgment call you make freely.
  Default to the active profile's effort. Only pass `effort` explicitly on
  `run_sub_agent` when the user asks for a different level for a specific
  task (e.g. "think hard on this one" -> `high`, "quick pass" -> `low`), and
  tell the user you are overriding it. The durable way to change effort is
  the `/nanites-effort` slash command or the dashboard settings — prefer that
  for anything the user wants to stick.

- Let Nanites resolve the model from the profile's registry — do not hardcode
  a model name from memory. If the registry has no fit for the role, the tool
  returns `no_model_for_role`; that is the signal to run
  `/nanites-new-profile`-adjacent registry work or tell the user the role is
  uncovered, not to guess a model.
- Two optional per-call knobs exist, use sparingly: `system_prompt_override`
  replaces the generated system prompt verbatim (a brief, static replacement is
  fine; reach for the profile's persistent `inference.system_prompt` first for
  anything durable); `reasoning_budget` overrides the planner's derived
  thinking-token cap. Do not pass either routinely — the planner defaults are
  correct for most calls.
- When the active profile has `dynamic_model: false`, Nanites does **not**
  hot-load a registry pick; it runs the user's already-loaded LM Studio models
  (role-matching registered ones, else any loaded model). Do not call
  `load_model` first in that mode — if nothing is loaded the tool returns
  `no_model_loaded`, the signal to load a model explicitly.
- When choosing among candidate models, weigh `performance_score` alongside
  registry-tested scores + orchestrator/user judgment. The performance score
  is an additional data point for stability/speed, not the sole winning
  criterion. Final pick must remain grounded in initial regimen results +
  user-approved judgments.
- If the profile's registry is sparse, consider `read_registry` first to see
  which models are tested and which roles they cover.
- Respect the profile's concurrency tier. Each tier is a *pair* — process
  capacity (max concurrent sub-agents) × LM Studio server slots per load. Forced
  sequential tiers (<12GB) are fixed at 1×1 and also serialize every inference
  behind a per-profile gate: at most one sub-agent chat is live at a time, so
  concurrent `run_sub_agent` calls queue, they do not overlap. Higher tiers run
  bounded concurrency up to their pair; a `concurrency_override` on the profile
  only picks from the tier's allowed pairs. If `run_sub_agent` refuses with
  `concurrency_limit`, do not retry in parallel — queue it or run sequential.

## Preferred-model pins, cloud routing, and vision

- **Pins (role -> provider + model).** A profile can pin a job type to a
  preferred model. When you request that role, Nanites auto-routes to the pin's
  provider/model before dynamic selection runs. An unusable pin (not
  registered / no usable key / no local registry entry) falls back to dynamic
  within the *same* provider; only a FULL provider outage crosses to the next
  enabled provider. A cloud run never silently drops to LM Studio, and a local
  pin never hops to cloud. Read pins with `list_role_pins`, change them with
  `set_role_pin` / `delete_role_pin`, and make the user's intent durable through
  the pin tools rather than re-passing `model_id` on every call. The seeded
  Cloudflare agentic set ships default pins covering the six common job types +
  `vision`; a custom pin you set is never overwritten by a re-seed.
- **Bulk seeding.** `/nanites-seed-agents` registers the canonical Cloudflare
  agentic models (plus `llama-3.2-11b-vision`) for a profile: catalog
  registration with each model's manifest capabilities, registry role-tagging
  (vision-capable models carry the `vision` role — D6), and the default role
  pins. Idempotent — run once per profile when the user wants the CF agentic
  fleet, no frontend one-by-one. Unknown ids are refused, never blind-inserted.
- **Tool-using cloud work needs a tool-capable model, and the failure is
  silent.** A cloud model that cannot call tools does not error: it answers in
  prose with `finish_reason: "stop"` and the tools are ignored, so the reply
  looks plausible and proves nothing. Routing now filters tool-bearing runs to
  models flagged `function_calling`, and refuses with
  `no_tool_capable_model` (whose `details.rejected` names what it skipped)
  rather than degrading quietly. Do not work around that refusal by
  hand-passing a `model_id` — pick a capable model. On Cloudflare the safe
  defaults are `@cf/openai/gpt-oss-120b` and `@cf/zai-org/glm-4.7-flash`;
  never route a multi-file review or any tool loop to
  `@cf/qwen/qwq-32b`, `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`, or
  `@cf/meta/llama-3.2-11b-vision-instruct`.
- **Reasoning models need the raised budget, and effort is how you give it.**
  A reasoning model spends completion tokens thinking before it writes
  `content`. Set the ceiling too low and the thinking consumes it: `content`
  comes back empty with `finish_reason: "length"` — you pay for the thinking
  and get no answer. Raise the ceiling and lower the reasoning effort instead;
  `low`/`medium`/`high` already carry the right ceiling tiers, so prefer
  `/nanites-effort` over hand-setting `output_token_ceiling`. Capability is not
  status: `function_calling` absent from Cloudflare's catalog means "not
  advertised", not "unsupported" — `qwq-32b` calls tools with no such flag —
  which is why the routing gate is a hard filter rather than a guess.
- **Vision work (analysis only, cloud-only).** When a task needs image
  *understanding* and the active profile has `vision_capable` true (the
  default), delegate to a vision-capable model rather than doing image analysis
  inline: Nanites resolves the `vision` role pin, else the best registered
  vision-capable model. Pass the image by local path, `http(s)` URL, or `data:`
  URI through the `images` list. A vision run with no tools uses any
  vision-capable model; a vision run that also needs tools is routed to a model
  that is both (on Cloudflare, `gemma-4-26b-a4b-it` or `qwen3.8-27b`) and is
  refused rather than downgraded when none exists. Image
  *generation*/editing is a separate non-chat surface — out of scope
  for v1. Flip `/nanites-vision` to `off` for a profile that must do no image
  work; the profile's `vision_capable` JSON field is the durable setting.
- **Machine-readable answers.** Pass `output_schema` (a JSON Schema) when
  something downstream parses the reply — a findings list, a classification, a
  row of extracted fields. Do not pass one when the brief's value *is* prose; a
  schema constrains the answer and costs an extra round when the model's first
  answer misses it. Check `validation.issues` for `output_schema_invalid` before
  assuming the reply parses: the run reports a non-conforming answer instead of
  failing, so silence there means conforming. Cloud-only — a local run asked for
  a schema is refused (`output_schema_local_unsupported`), never quietly answered
  in prose.

## Tool access

When the active profile's `tools.enabled` is true, a sub-agent can call the
configured MCP servers (e.g. filesystem + command-runner). LM Studio runs the tool
loop and executes calls server-side; `run_sub_agent` returns `tools_used`
(`Array<{tool, output}>`, arguments omitted). Facts to apply when delegating:

- You don't pick tools per call — the profile's `tools.integrations` + per-integration
  `allowed_tools` declare the full grant up front. Prefer `update_profile`'s `tools`
  field to change it; don't hand-roll tool definitions in the brief.
- `tools.enabled` defaults **false** (sub-agents tool-less). Turn it on only when a
  task genuinely needs FS or shell. `command-runner` is a real shell grant — keep it
  off unless required, and respect its `ALLOWED_COMMANDS`.
- A tool-enabled run surfaces the tools the sub-agent actually executed in
  `tools_used`; read it back to the user so they see what a delegated task touched.
- `plugin` integrations need LM Studio's "Allow calling servers from mcp.json" (and
  `ephemeral_mcp` needs "Allow per-request MCPs"); if disabled, the run returns a
  structured error rather than executing tools silently.

## Running and interpreting the judgment flow

For `orchestrator_judged` test units, `run_test_regimen` returns only
`pending_unit_ids`, never raw output. Read those units via
`get_pending_judgments` (cleaned raw output + rubric), judge them against the
rubric, then call `submit_test_judgment` with `user_approved: true` to make
the score final, or `false` to record it without finalizing.

- Judge against the rubric, not against what you hope the model is. Note
  anything stripped by the cleaner in `orchestrator_notes`.
- If a judgment is borderline, read the raw output again before deciding —
  the cleaning exists to protect you, not to hide model failure.
- After all pending units for a model are submitted, the registry entry is
  final. Do not trust a registry score that was never user-approved.

## Use-case adaptation

When a profile's `use_case` is not `nanites-default`, call
`check_adaptation`. If it reports a prompt, ask the user whether to draft
custom test units. Authoring new units is inference-heavy — do it here, in
the skill, using the same schema the validator expects, then register them
with `register_adapted_units` (it validates each and rejects invalid ones
with the issues surfaced). Reusing the default plan for a divergent use case
may not be well-calibrated; say so.

## Delegation patterns that stay cheap

- Batch small independent tasks into one `run_sub_agent` call per role rather
  than spawning many tiny agents.
- Prefer `diff_untested` + `run_untested_sweep` for registry population over
  manual one-off testing.
- For new model acquisition, `filter_by_guardrail` a Hugging Face search
  shortlist against the profile's tier before downloading — the tool returns
  an explicit reason per exclusion, which you should read back to the user.
- Let `download_and_wait` / `download_and_test` own download polling with
  backoff; do not poll manually.
