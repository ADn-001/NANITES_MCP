/**
 * Phase 63 gate — the reply cleaner must not eat real output.
 *
 * Each case below was measured against the pre-fix detector: the first four
 * kept 8%, 18%, 5% and 43% of their input, and the last two were the loops
 * that SHOULD be cut. The first four are the regression this file exists to
 * prevent; the last two are the capability that must survive it.
 */
import { describe, expect, it } from "vitest";
import { cleanReply } from "../../src/helpers/cleaner.js";
import { findRepetitionTail } from "../../src/helpers/repetition.js";

const NL = String.fromCharCode(10);

describe("structured output is never mistaken for a loop (H2)", () => {
  it("keeps an eight-row markdown table intact", () => {
    const unit = "Summary of results:" + NL + "| unit | score | status |" + NL;
    const input = unit.repeat(8);
    expect(findRepetitionTail(input)).toBeNull();
    expect(cleanReply(input).text).toContain("| unit | score | status |");
  });

  it("keeps repeated CSV rows intact", () => {
    const input = ("id,score" + NL + "1,0.95" + NL).repeat(5);
    expect(findRepetitionTail(input)).toBeNull();
  });

  it("keeps repeated code lines intact", () => {
    const input = ("Here is the fix:" + NL + "  if (item.id === currentId) return item.value;" + NL).repeat(6);
    expect(findRepetitionTail(input)).toBeNull();
  });

  it("keeps a results table attached to its prose", () => {
    const text =
      "The model performed well overall." + NL + NL +
      "| rule | score |" + NL + "|---|---|" + NL +
      ("| json_valid | 1.00 |" + NL).repeat(5);
    expect(findRepetitionTail(text)).toBeNull();
    expect(cleanReply(text).text).toContain("json_valid");
  });
});

describe("genuine degeneration is still cut", () => {
  it("cuts a long drifting repetition", () => {
    const text = "The answer is 42. " + "the quick brown fox jumps over the lazy dog. ".repeat(8);
    const out = cleanReply(text);
    expect(out.issues).toContain("repetition_loop_truncated");
    expect(out.text.length).toBeLessThan(text.length / 2);
  });

  it("cuts a prefixed token loop but keeps the prefix", () => {
    const out = cleanReply("Result: " + "pong".repeat(60));
    expect(out.issues).toContain("repetition_loop_truncated");
    // The floor keeps a meaningful prefix; it must never return empty text.
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text.startsWith("Result:")).toBe(true);
  });

  it("leaves ordinary prose alone", () => {
    const text = "I reviewed the code and found three issues worth reporting today.";
    expect(findRepetitionTail(text)).toBeNull();
    expect(cleanReply(text).text).toBe(text);
  });
});

describe("unclosed think tag is stripped (M2)", () => {
  it("removes a reasoning dump that has no closing tag", () => {
    const out = cleanReply("<think>Let me work through this step by step. And then I keep going.");
    expect(out.text).not.toContain("Let me work through");
    expect(out.issues).toContain("think_unclosed_stripped");
  });

  it("still handles a properly closed think block", () => {
    const out = cleanReply("<think>reasoning</think>The answer is 42.");
    expect(out.text).toBe("The answer is 42.");
  });
});

describe("template stripping preserves line structure (M3)", () => {
  it("keeps newlines when a template token is stripped", () => {
    const out = cleanReply(
      "<|im_start|>assistant" + NL + NL + "Line one." + NL + NL + "Line two." + NL + NL + "| a | b |",
    );
    expect(out.issues).toContain("template_token_stripped");
    // The old path collapsed every run of whitespace, destroying paragraph
    // breaks and table separators in any reply that leaked a token.
    expect(out.text).toContain(NL + NL);
    expect(out.text).toContain("| a | b |");
  });
});
