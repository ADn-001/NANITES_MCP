/**
 * Single-source the companion SKILL.md (Phase F / D8). The canonical file ships
 * inside the plugin (plugin/nanites/skills/nanites/SKILL.md, with frontmatter);
 * `.claude/skills/nanites/SKILL.md` is a generated artifact so Claude Code can
 * load it. Previously the .claude copy was hand-synced and drifted — it lost the
 * frontmatter block. This build step makes the copy byte-identical every time.
 * Cross-platform (no shell globbing): Node's fs does the copy.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "plugin", "nanites", "skills", "nanites", "SKILL.md");
const destDir = path.join(root, ".claude", "skills", "nanites");
const dest = path.join(destDir, "SKILL.md");

const content = readFileSync(src, "utf8");
if (!content.startsWith("---\n")) {
  throw new Error(`copy-skill: canonical SKILL.md has no frontmatter block — refusing to copy a frontmatter-less skill into .claude`);
}

mkdirSync(destDir, { recursive: true });
writeFileSync(dest, content);
process.stdout.write("copied plugin/nanites/skills/nanites/SKILL.md -> .claude/skills/nanites/SKILL.md\n");
