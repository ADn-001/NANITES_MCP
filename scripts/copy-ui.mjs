/**
 * Copy the companion UI into the build output so the UI server ships a single
 * static directory. The HTML is not self-contained: it references the logo
 * marks and the hover-skull frames as separate files, so those have to travel
 * with it or every image 404s at runtime. Cross-platform (no shell globbing):
 * Node's fs does the copying.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "frontend");
const src = path.join(srcDir, "nanites-dashboard.html");
const destDir = path.join(root, "dist", "ui");
const dest = path.join(destDir, "index.html");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
process.stdout.write(`copied frontend/nanites-dashboard.html -> dist/ui/index.html\n`);

// Assets the HTML references by relative URL.
const ASSET_PATTERN = /\.(png|gif|jpg|jpeg|svg|webp|ico)$/i;
const assets = readdirSync(srcDir).filter((f) => ASSET_PATTERN.test(f));
for (const name of assets) {
  copyFileSync(path.join(srcDir, name), path.join(destDir, name));
}

// Mirror the assets, don't accumulate them. copyFileSync only ever adds, so a
// renamed or deleted asset stayed in dist/ui forever and shipped in the plugin
// package — logo-retro.png outlived its source by a release.
//
// Only image assets are pruned. dist/ui also holds the compiled UI server
// (main.js, server.js, lifecycle.js, openSession.js, autostart.js) written
// there by tsc; deleting anything that merely "isn't a copied asset" takes the
// server with it.
const keep = new Set([...assets, path.basename(dest)]);
for (const stale of readdirSync(destDir)) {
  if (ASSET_PATTERN.test(stale) && !keep.has(stale)) {
    rmSync(path.join(destDir, stale));
    process.stdout.write(`removed stale dist/ui/${stale}\n`);
  }
}
process.stdout.write(`copied ${assets.length} UI asset(s) -> dist/ui/\n`);
