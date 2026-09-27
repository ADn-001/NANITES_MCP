import { describe, expect, it } from "vitest";
import { RunawayDetector } from "../../src/helpers/runaway.js";

describe("RunawayDetector", () => {
  const cfg = { maxTokens: 1000, windowChars: 200, minLoopChars: 24 };

  it("kills a repeating-token stream before a simulated timeout would fire", async () => {
    const detector = new RunawayDetector(cfg);
    const simulatedTimeoutMs = 5_000;
    const start = Date.now();

    let verdict = detector.track("init");
    for (;;) {
      verdict = detector.track("bad token. ");
      if (verdict.killed) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(Date.now() - start).toBeLessThan(simulatedTimeoutMs); // never outlive the timeout
    }

    expect(verdict.killed).toBe(true);
    expect(verdict.reason).toBe("repetition_loop");
    expect(Date.now() - start).toBeLessThan(simulatedTimeoutMs);
  });

  it("enforces the hard max-token ceiling", () => {
    const detector = new RunawayDetector({ maxTokens: 3, windowChars: 200, minLoopChars: 24 });
    expect(detector.track("a").killed).toBe(false);
    expect(detector.track("b").killed).toBe(false);
    const verdict = detector.track("c");
    expect(verdict.killed).toBe(true);
    expect(verdict.reason).toBe("max_tokens");
    expect(verdict.tokensSeen).toBe(3);
  });

  it("does not kill a normal stream", () => {
    const detector = new RunawayDetector(cfg);
    for (const token of ["hello ", "world ", "again ", "more ", "text "]) {
      expect(detector.track(token).killed).toBe(false);
    }
    expect(detector.count).toBe(5);
  });

  it("reset clears state", () => {
    const detector = new RunawayDetector({ maxTokens: 2, windowChars: 200, minLoopChars: 24 });
    detector.track("a");
    detector.reset();
    expect(detector.count).toBe(0);
    expect(detector.track("x").killed).toBe(false);
  });
});
