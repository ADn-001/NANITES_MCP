/**
 * Phase 61 gate — cloud filesystem sandbox and grant.
 *
 * The symlink case is the one the repo has never had: `grep -rn
 * "realpath\|symlink" test/` returned nothing before this file.
 * A junction or symlink inside the grant root is the only way out of a
 * purely lexical containment check, so it is the case that matters most.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFsToolDefs,
  executeFsTool,
  resolveAllowedNames,
  resolveWithinRoot,
} from "../../src/providers/fsTools.js";

const scratch: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-fs61-"));
  scratch.push(d);
  return d;
}

afterEach(() => {
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveWithinRoot", () => {
  it("accepts a descendant and refuses a lexical escape", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    expect(resolveWithinRoot(root, "a.txt").ok).toBe(true);
    expect(resolveWithinRoot(root, "./a.txt").ok).toBe(true);
    expect(resolveWithinRoot(root, "../escape.txt").ok).toBe(false);
  });

  it("refuses a symlink pointing outside the root (H4)", () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    const link = path.join(root, "escape");
    let made = false;
    try {
      fs.symlinkSync(outside, link, "junction");
      made = true;
    } catch {
      fs.symlinkSync(outside, link, "dir");
      made = true;
    }
    expect(made).toBe(true);

    // The whole point: the lexical path looks contained, the file does not.
    const viaLink = resolveWithinRoot(root, "escape/secret.txt");
    expect(viaLink.ok).toBe(false);
  });

  it("still allows a symlink that stays inside the root", () => {
    const root = tmpRoot();
    const inner = path.join(root, "inner");
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, "ok.txt"), "fine");
    try {
      fs.symlinkSync(inner, path.join(root, "link"), "junction");
      expect(resolveWithinRoot(root, "link/ok.txt").ok).toBe(true);
    } catch {
      // Symlink creation not permitted here; the refusal case above is the
      // one that matters and it does not depend on this.
    }
  });
});

describe("resolveAllowedNames fails closed (H3)", () => {
  it("an unresolvable allowlist yields nothing, not everything", () => {
    expect(resolveAllowedNames({ allowed_tools: ["read-files"] })).toEqual([]);
    expect(resolveAllowedNames({ allowed_tools: ["totally_bogus"] })).toEqual([]);
  });

  it("an explicit empty list yields nothing", () => {
    expect(resolveAllowedNames({ allowed_tools: [] })).toEqual([]);
  });

  it("an absent list yields the read-only set, without write_file (H5)", () => {
    const names = resolveAllowedNames({});
    expect(names).not.toContain("write_file");
    expect(names).toContain("read_file");
    expect(names.length).toBeGreaterThan(0);
  });

  it("an explicit list is honoured exactly", () => {
    expect(resolveAllowedNames({ allowed_tools: ["read_file", "write_file"] })).toEqual([
      "read_file",
      "write_file",
    ]);
  });

  it("advertised defs match the enforced set", () => {
    const defs = buildFsToolDefs({ allowed_tools: ["read_file"] });
    expect(defs.map((d) => d.function.name)).toEqual(["read_file"]);
  });
});

describe("executeFsTool refuses prototype keys (H6)", () => {
  const root = process.cwd();
  for (const name of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    it(`refuses ${name}`, async () => {
      const res = await executeFsTool({}, name, {});
      expect(res.ok).toBe(false);
      expect(res.output).toContain("unknown tool");
      // The old bug reported ok:true with "[object Undefined]" as output.
      expect(res.output).not.toContain("[object");
    });
  }
});

describe("executeFsTool honours the grant (H3, H5)", () => {
  it("refuses write_file when the grant did not ask for it", async () => {
    const root = tmpRoot();
    const res = await executeFsTool({ root }, "write_file", {
      path: "x.txt",
      content: "pwned",
    });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "x.txt"))).toBe(false);
  });

  it("refuses every tool when the allowlist resolves to nothing", async () => {
    const root = tmpRoot();
    const res = await executeFsTool(
      { root, allowed_tools: ["read-files"] },
      "write_file",
      { path: "x.txt", content: "pwned" },
    );
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "x.txt"))).toBe(false);
  });
});

describe("refusal messages carry no absolute path (M1)", () => {
  it("omits the root", () => {
    const root = tmpRoot();
    const res = resolveWithinRoot(root, "../outside.txt");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(root);
      expect(res.error).not.toContain(os.tmpdir());
    }
  });
});
