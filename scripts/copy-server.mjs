/**
 * Copy the compiled server into the plugin directory. The plugin's `.mcp.json`
 * launches `${CLAUDE_PLUGIN_ROOT}/dist/index.js`, and Claude Code refuses a
 * plugin path that escapes the plugin directory — so the artifact has to live
 * inside `plugin/nanites/`, not at the repo root where `tsc` writes it.
 *
 * Cross-platform (no shell globbing): Node's fs does the copy. Build output
 * stays gitignored; a plugin loaded from this repo is built first.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "dist");
const dest = path.join(root, "plugin", "nanites", "dist");

if (!existsSync(path.join(src, "index.js"))) {
  console.error("dist/index.js is missing — run the TypeScript build before copy-server.mjs");
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
process.stdout.write("copied dist -> plugin/nanites/dist\n");
