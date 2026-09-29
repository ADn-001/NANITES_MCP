/**
 * Copy the compiled server into the plugin directory. The plugin's `.mcp.json`
 * launches `${CLAUDE_PLUGIN_ROOT}/dist/index.js`, and Claude Code refuses a
 * plugin path that escapes the plugin directory — so the artifact has to live
 * inside `plugin/nanites/`, not at the repo root where `tsc` writes it.
 *
 * The plugin's runtime dependencies are installed here too. `node_modules` is
 * not tracked, so a fresh clone reaches this point with no plugin deps and the
 * plugin fails at startup with ERR_MODULE_NOT_FOUND on
 * '@modelcontextprotocol/server'. Installing as part of the build is what
 * makes `npm install && npm run build` sufficient to get a working plugin.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "dist");
const pluginDir = path.join(root, "plugin", "nanites");
const dest = path.join(pluginDir, "dist");

if (!existsSync(path.join(src, "index.js"))) {
  console.error("dist/index.js is missing — run the TypeScript build before copy-server.mjs");
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
process.stdout.write("copied dist -> plugin/nanites/dist\n");

// The plugin declares its own dependencies in plugin/nanites/package.json
// because its .mcp.json resolves modules relative to the plugin root. Install
// them unless they are already present — a repeat build should not re-run npm.
const pluginModules = path.join(pluginDir, "node_modules");
if (!existsSync(path.join(pluginModules, "@modelcontextprotocol"))) {
  // On Windows `npm` is a .cmd shim, which spawnSync can only exec through a
  // shell. `shell: true` concatenates rather than escapes its arguments, which
  // is fine here — every argument is a literal flag with no user input — but it
  // emits a DEP0190 warning, so run the shim through cmd.exe explicitly instead.
  const isWindows = process.platform === "win32";
  const result = isWindows
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", "install", "--no-audit", "--no-fund", "--silent"], {
        cwd: pluginDir,
        stdio: "inherit",
      })
    : spawnSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
        cwd: pluginDir,
        stdio: "inherit",
      });
  if (result.status !== 0) {
    console.error("failed to install the plugin's runtime dependencies");
    process.exit(1);
  }
  process.stdout.write("installed plugin/nanites dependencies\n");
} else {
  process.stdout.write("plugin/nanites dependencies already present\n");
}

