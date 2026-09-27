import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fresh scratch directory under the OS temp dir, outside ~/.nanites. */
export function scratchHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nanites-p3-"));
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

/** Recursive file listing, for asserting what a store actually wrote. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
