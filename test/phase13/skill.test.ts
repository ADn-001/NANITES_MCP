import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Phase 13 — SKILL.md performance_score guidance", () => {
  it("contains the exact additional-data-point line", () => {
    const skill = fs.readFileSync(path.join(process.cwd(), ".claude", "skills", "nanites", "SKILL.md"), "utf8");
    // Collapse wrapping so the assertion matches the intended sentence, not
    // the file's line-break positions.
    const normalized = skill.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "When choosing among candidate models, weigh `performance_score` alongside registry-tested scores + orchestrator/user judgment.",
    );
    expect(normalized).toContain("additional data point for stability/speed, not the sole winning criterion");
    expect(normalized).toContain("Final pick must remain grounded in initial regimen results + user-approved judgments.");
  });
});
