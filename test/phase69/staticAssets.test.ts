/**
 * Static dashboard assets.
 *
 * The dashboard references its logo marks and the hover-skull frames as
 * separate files rather than inline base64. When they were inlined, the HTML
 * was self-contained; the moment they became real files the UI server needed a
 * route to serve them, and it had none — every image 404'd and the dashboard
 * rendered with broken-image alt text. These cases pin both halves: the assets
 * are served, and the route cannot be walked out of its directory.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";

/** Files git actually tracks, so "committed" is checked against the index. */
const tracked = new Set(
  execFileSync("git", ["ls-files", "frontend"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean),
);

interface Harness {
  deps: ToolDeps;
  close(): Promise<void>;
  base: string;
}

async function setup(): Promise<Harness> {
  const home = scratchHome();
  const deps = buildDeps(home, { healthDisk: { availableGb: 500 } });
  const mock = await startMockLmStudio(liveHandler);
  deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url }, machine_specs: { vram_gb: 4 } });
  deps.profiles.switchProfile("t");
  const ui = await startUiServer(deps, { port: 0 });
  return {
    deps,
    base: `http://127.0.0.1:${ui.port}`,
    close: async () => {
      await ui.close();
      await mock.close();
      deps.close();
      cleanup(home);
    },
  };
}

describe("dashboard static assets", () => {
  it("serves a logo the HTML references", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/logo-retro-day.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = await res.arrayBuffer();
    // A real PNG, not an error envelope.
    expect(body.byteLength).toBeGreaterThan(1000);
    expect(new Uint8Array(body).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await h.close();
  });

  it("serves the hover-skull frames", async () => {
    const h = await setup();
    for (const name of ["skull-idle.png", "skull-spin.png"]) {
      const res = await fetch(`${h.base}/${name}`);
      expect(res.status, name).toBe(200);
    }
    await h.close();
  });

  it("404s an asset that does not exist rather than serving HTML", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/logo-does-not-exist.png`);
    expect(res.status).toBe(404);
    await h.close();
  });

  it("cannot be walked out of the asset directory", async () => {
    const h = await setup();
    // Every one of these would read a file outside dist/ui if the route
    // normalised the path instead of taking a bare filename.
    for (const p of [
      "/../package.json",
      "/%2e%2e/package.json",
      "/..%2fpackage.json",
      "/../src/ui/server.ts",
      "/nested/dir.png",
    ]) {
      const res = await fetch(`${h.base}${p}`);
      expect(res.status, p).not.toBe(200);
    }
    await h.close();
  });

  it("does not serve non-image files even inside the asset directory", async () => {
    const h = await setup();
    // index.html is reachable by design; nothing else is.
    for (const p of ["/index.html.bak", "/logo-retro-day.png.txt", "/.env"]) {
      const res = await fetch(`${h.base}${p}`);
      expect(res.status, p).not.toBe(200);
    }
    await h.close();
  });
});

/**
 * The first public release shipped a dashboard whose three logos 404'd: the
 * images were on disk, but a `.gitignore` line matched them, so they never
 * reached the repository. A passing HTTP test did not catch it either — the
 * suite runs against the working tree, where the files exist. Only a fresh
 * clone was wrong.
 *
 * So the check that matters is about version control, not the filesystem: every
 * asset the HTML names must be a tracked file, or the published package is
 * broken.
 */
describe("assets referenced by the dashboard are tracked", () => {
  const html = readFileSync(path.resolve(import.meta.dirname, "..", "..", "frontend", "nanites-dashboard.html"), "utf8");
  const referenced = new Set(
    [...html.matchAll(/src="([^"]+\.(?:png|gif|jpg|jpeg|svg|webp|ico))"/g)].map((m) => m[1]!),
  );
  // The three script-sourced frames are referenced from JS, not markup.
  referenced.add("skull-idle.png");
  referenced.add("skull-spin.png");

  it("found the dashboard's assets to check", () => {
    // If this drops to zero the regex stopped matching and this file is
    // vacuously passing — which is worse than no test.
    expect(referenced.size).toBeGreaterThanOrEqual(5);
  });

  it.each([...referenced])("%s is tracked by git", (name) => {
    const rel = `frontend/${name}`;
    expect(tracked.has(rel), `${rel} is referenced by the dashboard but is not committed`).toBe(true);
  });
});

/**
 * dist/ui is what the plugin actually serves, and copy-ui.mjs used to only
 * ever add files to it. A renamed or deleted asset therefore survived in the
 * build output indefinitely: logo-retro.png outlived its source by a release,
 * alongside four orphaned server modules, and all of it shipped in the package.
 *
 * So the check is that the two directories agree — not merely that every
 * referenced asset is present, which a stale extra file passes.
 */
describe("the built UI directory mirrors its source", () => {
  const asset = /\.(png|gif|jpg|jpeg|svg|webp|ico)$/i;
  const list = (dir: string) =>
    readdirSync(path.resolve(import.meta.dirname, "..", "..", dir))
      .filter((f) => asset.test(f))
      .sort();

  it("has no asset in dist/ui that frontend no longer has", () => {
    const orphans = readdirSync(
      path.resolve(import.meta.dirname, "..", "..", "dist", "ui"),
    ).filter((f) => asset.test(f) && !list("frontend").includes(f));
    expect(
      orphans,
      `stale in dist/ui, absent from frontend: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("has no asset in the plugin build that frontend no longer has", () => {
    const orphans = readdirSync(
      path.resolve(import.meta.dirname, "..", "..", "plugin", "nanites", "dist", "ui"),
    ).filter((f) => asset.test(f) && !list("frontend").includes(f));
    expect(
      orphans,
      `stale in plugin/nanites/dist/ui: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("carries every frontend asset into both build outputs", () => {
    const src = list("frontend");
    expect(src.length).toBeGreaterThan(0);
    expect(list("dist/ui")).toEqual(src);
    expect(
      readdirSync(
        path.resolve(import.meta.dirname, "..", "..", "plugin", "nanites", "dist", "ui"),
      )
        .filter((f) => asset.test(f))
        .sort(),
    ).toEqual(src);
  });
});
