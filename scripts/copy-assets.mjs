/**
 * Copy non-TypeScript runtime assets into dist.
 *
 * `tsc` only emits .js, so anything the built code loads at runtime by path
 * has to be copied explicitly. Right now that is the Needle bridge: it is a
 * .py file sitting next to its TypeScript, and without this it works in a dev
 * checkout and fails for anyone who installed the package — and only for the
 * optional helper, which is the worst time to find out.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ASSETS = [["src/router/helpers/needle_bridge.py", "dist/router/helpers/needle_bridge.py"]];

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = path.join(root, from);
  if (!existsSync(src)) {
    console.error(`missing runtime asset: ${from}`);
    process.exit(1);
  }
  const dest = path.join(root, to);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied++;
}
process.stdout.write(`copied ${copied} runtime asset(s) -> dist\n`);
