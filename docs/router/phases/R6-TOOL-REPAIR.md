# Phase R6 — Tool-Call Repair

**Goal:** a malformed tool call is repaired deterministically, or semantically by Needle 3, or it
fails loudly. It never arrives at a tool as `{}`.

**Depends on:** R1.
**Small phase, real bug fixed, and a genuinely good fit for the chosen model.**

---

## The bug

`src/providers/client.ts:102-127` — `parseToolCalls` parses `arguments` as a JSON string and falls
back to `{}` when it is malformed. The call then proceeds with empty parameters: a `write_file`
with no `path` and no `content`, a `search_files` matching nothing, or a crash inside the tool.
The failure is silent, which is the worst part — nothing in the response indicates the model's
intent was discarded.

The IR makes this structurally unrepresentable: `IRToolCall.arguments` is
`Record<string, unknown>`, so there is no `{}` state to fall into. The repair ladder is what
turns raw text into a valid IR value.

---

## Why Needle 3 is the right model for rung 4

`Cactus-Compute/needle3`, Apache-2.0, 121M parameters, distilled from Gemini 3.1 and post-trained
on 2B tokens of function-call data. Three properties make it a fit rather than a hope:

1. **The grammar is compiled from your actual tool schemas.** A byte-level grammar constrains
   every token, so the output is *guaranteed* to parse against the schema it was given. That
   converts the "semantically wrong but syntactically valid" failure class from possible to
   impossible for constrained fields.
2. **An ask no tool covers returns an empty list, not a guess.** This is the single most important
   behaviour for a repair rung: a model that returns nothing when it is unsure is safe to enable,
   because a wrong call is much harder to get out of it.
3. **It carries a calibrated confidence score.** The router can threshold on it rather than
   guessing when to trust the repair.

Compare the alternative this phase was originally scoped against — a general-purpose 0.5B
function-calling model. That model has no grammar guarantee and no empty-list behaviour, so
enabling it means accepting a real chance of a hallucinated `write_file` path. Needle 3 does not
have that problem, which is why it can sit on the critical path as an opt-in rung rather than
being quarantined.

---

## Implementation directions

### R6.1 — The ladder

`src/router/tools/repair.ts`, per §10 of the spec. Four rungs, stopping at the first success:

**1. `direct`** — `JSON.parse` as-is. Most calls land here.

**2. `extracted`** — scan for the outermost balanced `{...}`, tracking string literals and
escapes so a brace inside a string does not throw the count off. This single rung fixes the three
most common real-world malformations:
- the model wrapped its JSON in prose ("Here's the call: {...}")
- the model emitted a leading or trailing fragment ("{...} Let me know if...")
- the model emitted a code fence (```json ... ```)

It does **not** fix truncation — a truncated object has no closing brace, so the scan finds
nothing.

**3. `coerced`** — apply a fixed set of pure syntax corrections, then parse:

| Correction | Safe? |
|---|---|
| trailing commas before `}` or `]` | yes — never changes a valid value |
| Python `None` / `True` / `False` outside strings | yes — same JSON meaning |
| unquoted object keys | yes when the key matches `[A-Za-z_$][\w$]*` |
| single-to-double quotes | **not in general** — an apostrophe inside a double-quoted string breaks it |

Single-to-double quote conversion is the tempting one and the dangerous one. It is only safe when
the value contains **no** double quote and no backslash. Either implement it with that guard and
test the guard, or leave it out. Leaving it out is the better call for a first version.

**4. `needle`** — opt-in. See R6.4.

### R6.2 — Truncation, explicitly

Truncation is the case a model genuinely helps with, because a truncated object cannot be
recovered by syntax rules — information is simply missing. If the arguments string fails every
deterministic rung:

1. detect the truncation shape (unbalanced braces, ends mid-key, ends mid-string)
2. try closing the structure, if every required field is already present
3. only then offer the Needle rung

Step 2 is often sufficient and free. Close the open braces and strings, and if the result
validates against the schema, use it. This is the case worth testing hardest, because a truncated
`write_file` that has a `path` but a cut-off `content` is silently destructive.

### R6.3 — Schema validation

After any rung, validate the result against the declared tool's input schema:

- all `required` properties present
- no additional properties when `additionalProperties: false`
- types match
- no repair is accepted that changes a value's meaning — this is why the corrections table above is
  restricted to syntax that cannot do that

**`{}` remains legal when the schema genuinely has no required properties.** The check is against
the schema, not against emptiness. A test asserting "never empty" would be wrong.

### R6.4 — The Needle rung

`src/router/helpers/needleAdapter.ts`. The engine ships per platform as a sub-1MB binary
(`windows-x86_64/needle.exe` here), so the adapter spawns a subprocess — no Python, no WASM
runtime, no new npm dependency.

```sh
needle --model needle3.cact --tools tools.json --prompt "<the assistant's prose>"
```

Two invocation modes:

- **one-shot** per repair — simplest, but pays process start on every repair
- **`--serve`** — a long-lived subprocess the router starts once and reuses. Preferred once the
  rung is enabled, since repairs are on the request path

Configuration:

- `enable_model_repair` (D11), default **0**
- `needle_layers` — the ladder is 2 to 20 layers, and a smaller slice is faster. Default to the
  full model; allow tuning down.
- `needle_min_confidence` — below this, the repair is treated as a failure rather than a guess.
  Default chosen by measurement in R8, not guessed.

The rung must:

- pass the **actual tool schema** to Needle, so its grammar constrains the output to that schema
- treat an **empty `function_calls` list as a failure**, not as "no repair needed" — a repair
  request that returns nothing means the model declined, and that is an honest error
- be schema-validated with the same strictness as the deterministic rungs
- be observable — every invocation logged with input length, call count, confidence, and outcome

### R6.5 — Integration

Wire repair at the single point where tool calls enter the IR — inbound decode — so every
downstream consumer benefits and there is exactly one place to audit.

**Also fix `parseToolCalls` in the existing provider path.** The MCP server's cloud tool loop has
the same silent-`{}` behaviour today, and leaving it would mean the bug is only half fixed. The
shared repair module should serve both.

### R6.6 — Needle beyond repair

Needle's other two jobs land in R8: schema-guaranteed structured output for job artifacts, and
text embedding for catalog/transcript retrieval. They are not part of this phase.

---

## E2E test plan

`test/phaseR6/toolRepair.test.ts`

The ladder is a pure function, so the bulk of the suite is a fixture table.

**Corpus-based, one row per case.** Each row: raw string, schema, expected outcome, expected
method. Cases:

| Raw | Expected |
|---|---|
| `{"a":1}` | ok, `direct` |
| `Here you go: {"a":1}` | ok, `extracted` |
| `{"a":1}\nHope that helps!` | ok, `extracted` |
| "```json\n{\"a\":1}\n```" | ok, `extracted` |
| `{"a":1,}` | ok, `coerced` |
| `{"a":None}` | ok, `coerced` |
| `{a:1}` | ok, `coerced` |
| `{"a":1` (truncated, `a` present) | ok, `extracted` after closing |
| `{"a":1, "b":` (truncated, `b` missing) | fail, `tool_call_unrepairable` |
| `{"a":1` where schema requires `b` | fail |
| `{"a":"it's"}` with single-to-double attempted | **fail** or ok-with-guard — assert the guard, do not assert a happy path |
| `{` | fail |
| `` (empty) | fail unless the schema has no required properties |
| `{}` with a schema having no required properties | **ok** — the legal-empty case, must be tested |
| `{"a":1}` with schema requiring `b` | fail |
| deeply nested `{"a":{"b":[1,2,{"c":"}"}]}}` | ok, `direct` — a brace inside a string must not confuse the scanner |
| escaped quotes `{"a":"say \"hi\""}` | ok, `direct` |
| `{"a":1}{"b":2}` (two objects) | ok, `extracted`, first object — assert the documented choice |

1. **Corpus drives the tests** — one `it` per row so a failure names the malformation. A single
   looping test reports "corpus failed" and tells you nothing.
2. **Fuzz** — generate 500 random mutations of a valid call (truncation at every offset, injected
   prose, trailing punctuation, unicode). Assert the repair either returns a schema-valid object
   or `ok: false`. **Never assert it always succeeds** — some mutations are genuinely
   unrecoverable, and a test demanding otherwise forces a dangerous "fix".
3. **The bug itself** — a `write_file` call whose arguments are prose-wrapped. Assert the tool
   receives the real `path` and `content`. Run this through the **existing** `cloudToolLoop` path
   too, proving the fix reaches the MCP server, not just the router.
4. **No silent empty** — a call that cannot be repaired raises `tool_call_unrepairable`. Assert the
   tool executor is **never invoked**, on a spy, not on an error message.
5. **Truncation is safe** — a `write_file` with a complete `path` and a cut-off `content`. Assert
   the result is a **failure**, not a write with an empty or partial file. This is the test that
   matters most in the whole phase.
6. **Needle rung off by default** — with `enable_model_repair` off, a model-repairable case still
   takes the deterministic path and Needle is never spawned. Assert on a process-spawn spy.
7. **Empty list is a failure** — with the rung on and Needle returning `function_calls: []`, the
   result is `tool_call_unrepairable`. This is the single most important Needle-specific test: an
   empty list is how Needle declines, and treating it as success would be a serious bug.
8. **Schema passed through** — assert the tool schema the adapter sends matches the declared
   input schema, since that is what compiles Needle's grammar.
9. **Confidence threshold** — a Needle response below `needle_min_confidence` is treated as a
   failure. Test the boundary exactly at the threshold.
10. **Needle validates** — with it on and Needle returning a schema-invalid object, the result is
    a failure, not a pass.
11. **Repair is observable** — the log contains input length, method, call count, confidence, and
    outcome.
12. **Missing binary** — Needle not installed, rung enabled. Every case still succeeds via the
    deterministic ladder, or fails cleanly. **The router must not break because a 1MB binary is
    absent.**

**Non-vacuity.** The single-to-double-quote guard test and test 7 must each be shown failing
against an unguarded implementation. Test 7 in particular passes trivially against any code that
never checks the list at all — so the failure-path assertion must be made against real behaviour,
not a stub that always errors.

---

## Success criteria

- A prose-wrapped, code-fenced, or trailing-comma tool call executes with its real arguments.
- A truncated tool call fails rather than executing with partial arguments.
- An unrepairable call raises `tool_call_unrepairable` and **the tool is never invoked**.
- A schema with no required properties still accepts `{}`.
- A brace inside a string literal does not confuse the extractor.
- The fuzz corpus produces only schema-valid results or clean failures.
- The fix applies to the existing MCP server cloud tool loop, not only the router.
- The Needle rung is off by default, passes the real schema, treats an empty list as failure,
  honours a confidence threshold, and is observable.
- A missing Needle binary changes nothing.
- The existing suite is green and unchanged.
