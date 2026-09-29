/**
 * The standalone first-run path.
 *
 * The property under test: a machine that has never run a coding harness can
 * reach a working gateway through the CLI alone. That is the whole reason this
 * exists — the router reads the ACTIVE profile, and before this the only way to
 * create one was the MCP server's `/nanites-new-profile`, so a fresh install
 * dead-ended on "no active profile is set" for the one component that is meant
 * to stand alone.
 *
 * No network, no provider: these assert the setup path and its refusals, which
 * is where a first-run tool fails. The end-to-end proof is a live run, not a
 * mock.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const CLI = path.resolve("dist/cli/main.js");

afterEach(() => {
  while (homes.length) cleanup(homes.pop()!);
});

/** Run the built CLI against a scratch home, with a stripped environment. */
function run(home: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    // `env -i` equivalent: nothing leaks in from the developer's shell, which
    // is what makes this a real independence test rather than a decorated one.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
      NANITES_HOME: home,
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "" };
}

function freshHome(): string {
  const h = scratchHome();
  homes.push(h);
  return h;
}

describe("nanites-cli", () => {
  it("prints usage with no arguments and exits 0", () => {
    const r = run(freshHome(), []);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nanites-cli init/);
  });

  it("reports a virgin home as unconfigured, with exit 1", () => {
    // A first-run tool that exits 0 on "not set up" is a first-run tool a
    // script cannot trust.
    const r = run(freshHome(), ["status"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No active profile/);
    expect(r.out).toMatch(/nanites-cli init/);
  });

  it("creates a profile and makes it active", () => {
    const h = freshHome();
    const r = run(h, ["init", "--name", "gateway"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Created profile "gateway"/);
    const pointer = JSON.parse(fs.readFileSync(path.join(h, "active_profile.json"), "utf8")) as { name: string };
    expect(pointer.name).toBe("gateway");
  });

  it("is idempotent — re-running init changes nothing", () => {
    const h = freshHome();
    run(h, ["init", "--name", "gateway"]);
    const before = fs.readFileSync(path.join(h, "active_profile.json"), "utf8");
    const again = run(h, ["init", "--name", "gateway"]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already exists/);
    expect(fs.readFileSync(path.join(h, "active_profile.json"), "utf8")).toBe(before);
  });

  it("refuses a missing key instead of prompting", () => {
    // A CLI that blocks on stdin cannot run from a service manager, and an
    // EOF on a pipe would otherwise look like an empty key.
    const h = freshHome();
    run(h, ["init"]);
    const r = run(h, ["add-key", "cloudflare"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/NANITES_API_KEY_CLOUDFLARE/);
  });

  it("requires account_id for cloudflare, and says where to find it", () => {
    const h = freshHome();
    run(h, ["init"]);
    const r = run(h, ["add-key", "cloudflare"], { NANITES_API_KEY_CLOUDFLARE: "fake" });
    expect(r.code).toBe(2);
    // The account id is the single most common first-run failure, and it is
    // NOT in the API token, so the message has to say so.
    expect(r.err).toMatch(/--account-id/);
    expect(r.err).toMatch(/not the API token/);
  });

  it("rejects an unknown provider and names the valid ones", () => {
    const h = freshHome();
    run(h, ["init"]);
    const r = run(h, ["add-key", "nope"], { NANITES_API_KEY_NOPE: "x" });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/cloudflare, openrouter/);
  });

  it("adds a key from the environment without echoing it", () => {
    const h = freshHome();
    run(h, ["init"]);
    const r = run(h, ["add-key", "cloudflare", "--account-id", "acct-1", "--nickname", "work"],
      { NANITES_API_KEY_CLOUDFLARE: "sk-super-secret-value" });
    expect(r.code).toBe(0);
    // The secret must not appear in stdout OR stderr: a CLI that echoes a key
    // puts it in a terminal scrollback and a CI log.
    expect(r.out).not.toContain("sk-super-secret-value");
    expect(r.err).not.toContain("sk-super-secret-value");
    expect(r.out).toMatch(/Added cloudflare key work/);
  });

  it("status shows the key as ready and can serve", () => {
    const h = freshHome();
    run(h, ["init"]);
    run(h, ["add-key", "cloudflare", "--account-id", "a"], { NANITES_API_KEY_CLOUDFLARE: "sk-x" });
    const r = run(h, ["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Active profile: default/);
    expect(r.out).toMatch(/cloudflare/);
    expect(r.out).toMatch(/Router can serve: yes/);
  });

  it("add-key without an active profile points at init", () => {
    const h = freshHome();
    const r = run(h, ["add-key", "openrouter"], { NANITES_API_KEY_OPENROUTER: "sk-x" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/nanites-cli init/);
  });

  it("rejects an unknown command with usage and exit 2", () => {
    const r = run(freshHome(), ["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command/);
  });
});

describe("argument parsing", () => {
  it("accepts --flag value and --flag=value alike", async () => {
    const { parseArgs } = await import("../../src/cli/main.js");
    expect(parseArgs(["init", "--name", "x"]).flags["name"]).toBe("x");
    expect(parseArgs(["init", "--name=x"]).flags["name"]).toBe("x");
  });

  it("treats a trailing --flag as a boolean, not the next command's flag", async () => {
    // Without this, `add-key cloudflare --nickname` would swallow "discover".
    const { parseArgs } = await import("../../src/cli/main.js");
    const p = parseArgs(["add-key", "cloudflare", "--nickname"]);
    expect(p.flags["nickname"]).toBe(true);
  });
});
