# Phase R1 — Wire Layer and Inbound Gateway

**Goal:** `POST /v1/messages` and `POST /v1/chat/completions` both accept a real request, route
it through the existing provider stack, and return a correct complete response in the caller's
dialect. Non-streaming first.

**This is the highest-risk phase in the project.** The Anthropic Messages contract is strict,
Claude Code is strict about it, and getting the IR right here determines whether phases R2–R7
are routine or painful.

**Depends on:** R0.

---

## Implementation directions

### R1.1 — The IR

Create `src/router/ir/types.ts` exactly as specified. It is the pivot; nothing from either
dialect's shape appears in it, and neither dialect's module imports the other's.

The one type decision worth restating: `IRToolCall.arguments` is
`Record<string, unknown>`, never a string. The IR is structurally incapable of representing the
`arguments: "{}"` state that `parseToolCalls` currently produces — that is the bug fixed in R6,
and the type is what makes it unrepresentable.

### R1.2 — Inbound decoders

- `src/router/inbound/anthropic.ts` — `decodeAnthropicRequest(body): IRRequest` and
  `encodeAnthropicResponse(ir): object`, per §3.3 of the spec.
- `src/router/inbound/openai.ts` — the equivalent pair.
- Both are pure functions: body in, IR out. No I/O, no store access, no provider knowledge. This
  makes them exhaustively testable without a network, which is the only sane way to get coverage
  on translation code.
- Every decode failure throws `router_invalid_request` with the field path in `details`, not a
  stack trace.

**A field-by-field translation table, not prose.** The spec's §3.3 table is the minimum. Enumerate
every field of both request shapes and record what it maps to, including the ones that do not map
(`user`, `service_tier`, `logprobs`, `n`, `frequency_penalty`) — each either dropped with a
recorded reason or carried. An unmapped field found later is a surprise; a mapped one is a
decision.

### R1.3 — Outbound adapter

`src/router/outbound/dispatch.ts` per §4.1 of the spec.

It translates `IRRequest` → the existing `ChatRequest`, calls
`chatWithBudgetRetry` (`src/providers/cloudPlanner.ts:215`), and translates the result back. It
does **not** re-implement retry, budget retry, empty-reply detection, cost computation, or error
classification. The value here is that the entire existing failure-handling behaviour is
inherited rather than rebuilt, including the Cloudflare-specific budget handling.

Model resolution in this phase is deliberately dumb: the model string from the request is passed
through to the provider after namespacing. Aliases land in R3.

### R1.4 — Model resolution, minimal

The inbound `model` is one of:
- an advertised id — not yet possible in R1, so
- a namespaced id (`provider[:endpoint]:model_id`) — resolved via the existing
  `providerModelId.ts` helpers, or
- a bare model id — resolved by searching the catalog for a unique provider match, and rejected
  as ambiguous otherwise.

Reject the ambiguous case with `alias_unknown` listing the candidates. This is the same trap the
`cloud_provider_required` fix in the MCP server walked into; the router should not rediscover it.

### R1.5 — Request path

`POST /v1/messages` and `POST /v1/chat/completions`:

1. auth
2. dialect detect
3. decode → IR
4. resolve model → (provider, endpoint, model_id)
5. select key (R1 uses a single available key; strategy lands in R2)
6. dispatch
7. encode IR → dialect response

Errors at each step return the dialect's native error envelope.

---

## E2E test plan

`test/phaseR1/wireRoundTrip.test.ts` — decoder unit tests (no I/O)

1. **Anthropic → IR** — every field in §3.3, one assertion each. Include a base64 image source, a
   thinking block, a `tool_use` block, a `tool_result` block, and a system prompt given as a block
   array.
2. **IR → Anthropic** — the round trip returns the original body for the covered field set.
   Property-style: for a fixture corpus of representative bodies, `decode` then `encode` is
   identity on every field the IR is specified to preserve.
3. **OpenAI → IR** — string content, part-array content, `input_audio`, parallel tool calls, a
   `tools[].function.parameters` schema.
4. **Cross-dialect** — an Anthropic body decoded to IR and encoded as OpenAI, and the reverse.
   The interesting assertions are the lossy ones: a thinking block has no OpenAI representation,
   and the test should assert **that it is dropped, loudly**, rather than silently vanishing.
5. **Malformed input** — each of: missing `model`, empty `messages`, `max_tokens` absent on
   Anthropic (required there), a tool without `name`. Each throws `router_invalid_request` with a
   field path.

`test/phaseR1/gatewayE2E.test.ts` — full path, stubbed fetch

6. A stubbed provider (the real `ReadableStream`-backed shape, per
   `test/phase70/genericEndpoints.test.ts` — a hand-rolled `json()` stub does not work because
   `readSseLines` drives `getReader()`).
7. **OpenAI client → router → provider → OpenAI response**: the provider's model name arrives
   **unstripped-of-namespace** at the wire, the response comes back in OpenAI shape, `usage`
   is populated, `finish_reason` is correct.
8. **Anthropic client → router → provider → Anthropic response**: the response is in Anthropic
   shape including `type:"message"` and the `stop_reason` mapping (`end_turn` from `stop`,
   `max_tokens` from `length`, `tool_use` from `tool_calls`).
9. **Ambiguous bare model id** — two providers serve the same id; the request is rejected with
   `alias_unknown` naming both. Assert it fails against the current lenient behaviour.
10. **Provider failure** — the provider returns 429. The client receives a structured error in
    its own dialect, and the underlying `NanitesError` code (`provider_rate_limited`) survives
    into the response body so a harness can act on it.
11. **Unauthenticated** — 401 in the correct dialect shape for each.

**Non-vacuity.** Test 4 and test 9 are the two that most easily pass while broken. Prove 9 fails
by making the resolver pick the first match instead of rejecting; prove 4 fails by removing the
loud-loss assertion and confirming nothing notices.

---

## Success criteria

- Both endpoints serve a real non-streaming round trip against a stubbed provider and a real
  LM Studio instance.
- Claude Code issues a request and receives a well-formed `message` response. Verify against an
  **actual captured Claude Code session**, not a hand-written sample — the client is stricter
  than any fixture.
- A harness-side OpenAI SDK works against the OpenAI endpoint.
- Every error path returns the caller's dialect envelope, never the other one's.
- Decode/encode are pure and fully covered with no store or network dependency.
- Lossy cross-dialect conversions are asserted, not silent.
- The existing suite is green and unchanged.
