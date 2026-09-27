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
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";

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
    const res = await fetch(`${h.base}/logo-retro.png`);
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
    for (const p of ["/index.html.bak", "/logo-retro.png.txt", "/.env"]) {
      const res = await fetch(`${h.base}${p}`);
      expect(res.status, p).not.toBe(200);
    }
    await h.close();
  });
});
