/**
 * Copy the companion UI into the build output so the UI server ships a single
 * static directory. The HTML is not self-contained: it references the logo
 * marks and the hover-skull frames as separate files, so those have to travel
 * with it or every image 404s at runtime. Cross-platform (no shell globbing):
 * Node's fs does the copying.
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
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
process.stdout.write(`copied ${assets.length} UI asset(s) -> dist/ui/\n`);
