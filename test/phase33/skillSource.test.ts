/**
 * Phase 33 gate (Phase F, D8) — SKILL.md single-source. The canonical skill
 * ships in the plugin with frontmatter; `.claude/skills/nanites/SKILL.md` is a
 * generated artifact refreshed by `scripts/copy-skill.mjs` on every build. The
 * artifact must be diff-identical to the canonical file (the old hand-synced
 * copy had drifted — it had lost its frontmatter block entirely).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CANONICAL = path.join(ROOT, "plugin", "nanites", "skills", "nanites", "SKILL.md");
const ARTIFACT = path.join(ROOT, ".claude", "skills", "nanites", "SKILL.md");
const COPY_SCRIPT = path.join(ROOT, "scripts", "copy-skill.mjs");

describe("Phase 33 gate — SKILL.md single source (F1)", () => {
  it("the canonical skill carries frontmatter (name: nanites)", () => {
    const canonical = readFileSync(CANONICAL, "utf8");
    expect(canonical.startsWith("---\nname: nanites")).toBe(true);
  });

  it("the .claude artifact is diff-identical to the canonical file", () => {
    expect(readFileSync(ARTIFACT, "utf8")).toBe(readFileSync(CANONICAL, "utf8"));
  });

  it("the build step reproduces the artifact idempotently (byte-identical)", () => {
    execFileSync(process.execPath, [COPY_SCRIPT], { cwd: ROOT });
    expect(readFileSync(ARTIFACT, "utf8")).toBe(readFileSync(CANONICAL, "utf8"));
    expect(readFileSync(ARTIFACT, "utf8").startsWith("---\nname: nanites")).toBe(true);
  });
});
