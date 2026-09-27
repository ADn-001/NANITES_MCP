/**
 * Phase 57 gate — block-scale repetition in the cleaner.
 *
 * The token-loop detector in `repetition.ts` catches short periodic tails. It
 * did not catch the case that motivated this phase: a `glm-4.7-flash` attempt
 * returned ~40,100 chars of near-repeated prose, passed the cleaner untouched,
 * and reached the orchestrator as an "answer". These tests pin the detector
 * that catches it — and, more importantly, pin the shapes it must NOT touch,
 * because a cleaner that eats legitimate long output is worse than the bug.
 *
 * The harmony-token fixtures are the live strings captured from a real run
 * (`gpt-oss-120b` returned its tool call as text with raw markers).
 */
import { describe, expect, it } from "vitest";
import { cleanReply } from "../../src/helpers/cleaner.js";

/** 461 chars, repeated to build the measured 40k-char degeneration. */
const PARAGRAPH = [
  "The registry records a rolling performance score for every model that has completed at least one sub-agent run, and that score feeds the next load's timeout.",
  "Loading behaviour is therefore measured rather than assumed, and a model that stalls on load is penalised in the next score it earns.",
  "The sub-agent pool holds a single resident instance per key under sequential tiers, so a second caller queues behind the first instead of loading the same weights twice.",
].join(" ");

const HEALTHY = Array.from(
  { length: 20 },
  (_, i) =>
    `Finding ${i + 1}: the ${["loader", "router", "cleaner"][i % 3]} path at line ${i * 7 + 11} handles ${i + 2} cases before falling back to the dynamic selector for role ${i % 4}.`,
);

/** Eight distinct sentences cycled across 24 lines: no exact 3-line block
 * repeats four times, but only eight distinct lines exist — the shape the
 * ratio check exists to catch. */
const POOL = [
  "The router keeps a sticky model per role, so that a retry after a transport error lands on the same weights instead of silently switching provider partway through a review.",
  "Key rotation is round-robin inside a single provider, and a key retired for quota exhaustion comes back at the next UTC midnight rather than on the following call.",
  "The loop advertises exactly the filesystem tools the profile granted, and Nanites executes each of those calls itself, because a hosted model cannot reach the local disk on its own.",
  "Every round of the tool loop re-sends the whole transcript, so the round count is the cost, which makes the round cap a budget decision rather than a safety net for a stuck model.",
  "Validation runs on the reply before it reaches the orchestrator, and every issue it raises names what was removed, so that the caller can judge exactly what was lost and why.",
  "The performance score blends speed, time to first token and stability across the last twenty runs, minus a penalty applied for models that take too long to load into memory.",
  "A profile without an explicit machine-spec override inherits the baseline tier, which forces one model at a time behind the per-profile inference gate used for sequential runs.",
  "Cost saved is computed from the logged token usage against the profile's configured pricing, so an unpriced model reports a null cost rather than a made-up number in the report.",
];

/** The live `gpt-oss-120b` reply from the D2 gate, verbatim. */
const HARMONY_LIVE =
  "<|channel|>analysis: we need review five files for defects. Continue reading remaining files: costSavedReport and inferencePlanner.<|end|><|start|>assistant to=functions.read_filecommentary json" +
  '{"path":"src/workflows/costSavedReport.ts","limit":4000}<|call|>';

describe("Phase 57 — block-scale repetition", () => {
  it("cuts a degenerated reply at the point it starts repeating", () => {
    const raw = Array.from({ length: 100 }, () => PARAGRAPH).join("\n");
    expect(raw.length).toBeGreaterThan(40_000);

    const res = cleanReply(raw);
    expect(res.cleaned).toBe(true);
    expect(res.issues).toContain("repeated_block");
    // The first copy is real content; everything after it is the loop.
    expect(res.text).toBe(PARAGRAPH);
  });

  it("keeps the healthy preamble and drops only the loop after it", () => {
    const raw = [...HEALTHY, ...Array.from({ length: 100 }, () => PARAGRAPH)].join("\n");

    const res = cleanReply(raw);
    expect(res.issues).toContain("repeated_block");
    expect(res.text).toBe([...HEALTHY, PARAGRAPH].join("\n"));
  });

  it("flags low novelty when no exact block repeats", () => {
    const raw = Array.from({ length: POOL.length * 3 }, (_, i) => POOL[i % POOL.length]!).join("\n");
    expect(raw.length).toBeGreaterThan(4_000);
    expect(new Set(raw.split("\n")).size).toBe(POOL.length);

    const res = cleanReply(raw);
    expect(res.issues).toContain("low_novelty");
    expect(res.issues).not.toContain("repeated_block");
    expect(res.text).toBe(POOL.join("\n"));
  });

  it("leaves long, genuinely varied output alone", () => {
    const boilerplate = "See the appendix for the raw numbers.";
    const body = Array.from({ length: 60 }, (_, i) => [
      `Finding ${i + 1}: the ${["loader", "router", "cleaner"][i % 3]} path at line ${i * 7 + 11} handles ${i + 2} cases before falling back to the dynamic selector for role ${i % 4}.`,
      ...(i % 4 === 3 ? [boilerplate] : []),
    ]).flat();
    const raw = body.join("\n");
    expect(raw.length).toBeGreaterThan(4_000);

    const res = cleanReply(raw);
    expect(res.text).toBe(raw);
    expect(res.cleaned).toBe(false);
    expect(res.issues).toEqual([]);
  });

  it("leaves short repeated output alone", () => {
    const short = "Line A\nLine A\nLine A\nDone.";
    expect(cleanReply(short).issues).toEqual([]);

    const answer = [
      "Step one: read the file.",
      "Step one: read the file.",
      "Step two: summarise the findings.",
      "Step three: answer the question.",
      "Step four: stop.",
      "Done.",
    ].join("\n");
    const res = cleanReply(answer);
    expect(res.text).toBe(answer);
    expect(res.cleaned).toBe(false);
  });

  it("does not regress the artifacts the cleaner already handled", () => {
    expect(cleanReply("Answer: <think>checking.</think>42").issues).toContain("think_tag_stripped");
    expect(cleanReply("abc").issues).toContain("control_chars_stripped");
    const busted = '{"name": "Alex", }extra';
    const res = cleanReply(busted);
    expect(res.issues).toContain("malformed_json_flagged");
    expect(res.text).toBe(busted);
  });
});

describe("Phase 57 — harmony template tokens", () => {
  it("strips the markers from the live gpt-oss-120b reply", () => {
    const res = cleanReply(HARMONY_LIVE);
    expect(res.cleaned).toBe(true);
    expect(res.issues).toContain("template_token_stripped");
    expect(res.text).not.toMatch(/<\|/);
    // The model's own words survive; only the template scaffolding goes.
    expect(res.text).toContain("we need review five files for defects");
  });

  it("leaves prose that merely names the markers alone", () => {
    const prose =
      "The reply carried harmony channel markers and a call token as text, so the loop read it as an answer with no tool calls.";
    const res = cleanReply(prose);
    expect(res.cleaned).toBe(false);
    expect(res.issues).toEqual([]);
    expect(res.text).toBe(prose);
  });
});
