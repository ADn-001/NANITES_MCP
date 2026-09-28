# Phase R2 — Streaming

**Goal:** `stream: true` works on both endpoints, with correct SSE event sequencing per dialect.

**Depends on:** R1.

**No other phase may start until this is done.** Every later phase that produces incremental
output — modality generation, async jobs, tool loops — inherits its streaming correctness from
here. Building streaming once, properly, is cheaper than building it three times partially.

---

## The two contracts

**OpenAI** is the easy one. `chat.completion.chunk` frames, `delta` accumulation, terminating
`data: [DONE]`. The existing `readSseLines` (`src/providers/client.ts:234-255`) already reads the
upstream side of this.

**Anthropic** is the hard one, and it is a state machine, not a format conversion:

```
message_start
  content_block_start   {index, content_block}
  content_block_delta*  {index, delta}
  content_block_stop    {index}
message_delta          {delta:{stop_reason}, usage:{output_tokens}}
message_stop
```

---

## Implementation directions

### R2.1 — A shared SSE writer

```ts
// src/router/stream/sse.ts
export interface SseWriter {
  event(name: string, data: unknown): Promise<void>;
  raw(data: string): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
}
```

One writer, both dialects, plus the `/v1/jobs/:id/events` progress stream in R7. It must handle
client disconnect (stop writing, abort the upstream), backpressure, and header setup exactly
once. Getting disconnect handling right matters more than it looks: a client that hangs up
mid-generation must cancel the provider call, or the user's credits burn on output nobody
receives.

### R2.2 — Anthropic stream encoder

Translate IR deltas to Anthropic events:

| IR | Anthropic events |
|---|---|
| first text of a block | `content_block_start` `{type:"text",text:""}` then one `content_block_delta` `{type:"text_delta"}` |
| subsequent text | `content_block_delta` `{type:"text_delta"}` |
| thinking | `content_block_start` `{type:"thinking",thinking:""}`, deltas `{type:"thinking_delta"}`, and a matching `signature_delta` when signed |
| a tool call | `content_block_start` `{type:"tool_use",id,name,input:{}}`, deltas `{type:"input_json_delta",partial_json}` |
| end of stream | `content_block_stop` per open index, then `message_delta`, then `message_stop` |

Hard rules, each of which has bitten someone:

- **Every `content_block_start` gets exactly one `content_block_stop`.** Indexes must be
  sequential from 0. A dangling block hangs the client.
- **Tool `input_json_delta` fragments are forwarded raw, not parsed.** A partial JSON fragment
  is not valid JSON. The repair ladder runs once, on the assembled string, at `content_block_stop`
  (R6). Parsing mid-stream is the single most common way to corrupt a tool call.
- **`message_start` carries real `input_tokens`**; the final `message_delta` carries the real
  cumulative `output_tokens`. Both are required and both are frequently wrong in hand-rolled
  implementations.
- **A `ping` every ≤30s** on long generations.
- **An error mid-stream still emits `message_stop`.** The client is not left waiting for a
  terminator that never comes. The error is carried in a `content_block_delta` of `type:"error"`
  or, for a pre-stream failure, a proper `error` event before `message_start`.

### R2.3 — OpenAI stream encoder

Much simpler. First chunk carries `delta.role = "assistant"` and empty content. Then `content`
deltas. A tool call arrives as a chunk with `delta.tool_calls[0].id`, a chunk with
`delta.tool_calls[0].function.name`, and chunks with `delta.tool_calls[0].function.arguments`
fragments. Final chunk carries `finish_reason` and `usage` (when `stream_options.include_usage`
is set). Then `data: [DONE]`.

The same fragment rule applies: arguments fragments are forwarded raw and assembled.

### R2.4 — Assembling the IR from upstream

The existing clients each have their own inlined SSE consume loop, and none of them capture
`usage` from the stream — only the unused `reassembleStream` (`src/providers/client.ts:257-308`)
reads `event.usage`. Rather than duplicating a fifth copy of that loop, extract the shared
assembler and have the router use it. Refactoring the four existing clients to use it is optional
and should be done as a separate, obviously-safe commit — it changes code that currently works.

Note that `reassembleStream` is currently dead code with a live-quality implementation sitting in
it. Verify it against real provider output before trusting it; the four inlined loops were
written against observed quirks that it may not handle.

---

## E2E test plan

`test/phaseR2/streaming.test.ts`

The critical property is **event sequence equality**. Capture the emitted SSE frames, parse them
into a structured list, and assert the exact sequence.

1. **Text stream, Anthropic** — exact sequence:
   `[message_start, content_block_start(0,text), content_block_delta×N(0), content_block_stop(0),
   message_delta, message_stop]`. Assert indexes are sequential from 0, and that every `start`
   has a `stop`.
2. **Text stream, OpenAI** — first chunk has `delta.role`, last has `finish_reason`, then
   `[DONE]`. Assert `[DONE]` is present exactly once and is last.
3. **Tool call stream, Anthropic** — `content_block_start` with `type:"tool_use"`, one
   `input_json_delta` per upstream fragment, `content_block_stop`. **Assert the concatenated
   `partial_json` equals the original arguments string byte for byte.** This is the test that
   catches mid-stream parsing.
4. **Tool call stream, OpenAI** — the `tool_calls[0].index` is consistent across chunks, `id`
   appears once, and concatenated `function.arguments` equals the original.
5. **Thinking block stream, Anthropic** — `thinking_delta` frames, and a `signature_delta` when
   the upstream supplied a signature.
6. **Usage accounting** — `message_start.input_tokens` equals upstream prompt tokens;
   `message_delta.usage.output_tokens` equals upstream completion tokens. Both streams.
7. **Upstream error mid-stream** — the provider fails after two deltas. Assert `message_stop` is
   still emitted, and that the client's view terminates rather than hanging.
8. **Client disconnect** — the response socket closes after the first chunk. Assert the upstream
   `AbortSignal` fired. (Assert on a real abort, not a flag: a stub that ignores `signal` will
   pass a naive test.)
9. **Empty upstream** — zero deltas. Still emits a well-formed, terminated stream in both
   dialects.
10. **Interleaved blocks** — text, then a tool call, then more text. Assert three
    start/stop pairs with indexes 0, 1, 2 in order.
11. **Ping cadence** — a slow stream emits a `ping` at ≤30s. Test the timer function directly
    with a fake clock rather than sleeping 30 seconds.

**Conformance harness.** Beyond unit tests, build `test/phaseR2/fixtures/` from **real captured
streams** — one per provider, recorded from live traffic, with secrets redacted. Replay them and
assert the emitted sequence. A fixture derived from a hand-written sample only proves the encoder
matches the author's assumptions.

---

## Success criteria

- Claude Code streams a response and renders token by token. Verified against a real session.
- A `tool_use` block's assembled `partial_json` is byte-identical to the upstream arguments.
- Every stream terminates, including on error and on empty upstream. A test asserts there is no
  path that emits an unterminated stream.
- Client disconnect aborts the upstream call.
- Replay fixtures from all four existing providers plus a generic gateway produce correct
  sequences.
- Latency overhead added by streaming translation is under 50ms per chunk, measured not assumed.
- The existing suite is green and unchanged.
