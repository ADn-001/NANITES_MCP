/**
 * Phase 62 gate — vision path confinement.
 *
 * resolveLocalPath used to stat and read whatever absolute path it was
 * handed: it never called resolveWithinRoot and never imported fsTools, so a
 * vision delegation could read any file on the host and ship it to a
 * provider as a base64 data: URI. These cases pin the confinement, the
 * magic-byte check, and the data: URI cap that did not exist before.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, resolveImageUri, resolveImageUris } from "../../src/providers/vision.js";

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(d);
  return d;
}

/** A minimal but genuinely valid 1x1 PNG. */
const PNG_1PX = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

let root = "";
let outside = "";

beforeEach(() => {
  root = tmp("nanites-vis-root-");
  outside = tmp("nanites-vis-outside-");
  process.env.NANITES_VISION_ROOTS = root;
});

afterEach(() => {
  delete process.env.NANITES_VISION_ROOTS;
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("local image paths are confined", () => {
  it("accepts a real image inside an allowed root", async () => {
    const file = path.join(root, "pic.png");
    fs.writeFileSync(file, PNG_1PX);
    const uri = await resolveImageUri(file);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("refuses a file outside every allowed root (H1)", async () => {
    const secret = path.join(outside, "id_rsa");
    fs.writeFileSync(secret, "-----BEGIN PRIVATE KEY-----");
    await expect(resolveImageUri(secret)).rejects.toThrow();
  });

  it("refuses a traversal out of the root", async () => {
    const secret = path.join(outside, "id_rsa");
    fs.writeFileSync(secret, "-----BEGIN PRIVATE KEY-----");
    await expect(resolveImageUri(path.join(root, "..", path.basename(outside), "id_rsa"))).rejects.toThrow();
  });

  it("refuses a symlink out of the root", async () => {
    const secret = path.join(outside, "creds.txt");
    fs.writeFileSync(secret, "token");
    const link = path.join(root, "link");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      fs.symlinkSync(outside, link, "dir");
    }
    await expect(resolveImageUri(path.join(link, "creds.txt"))).rejects.toThrow();
  });
});

describe("content must actually be an image", () => {
  it("refuses an HTML payload renamed to .png", async () => {
    const file = path.join(root, "evil.png");
    fs.writeFileSync(file, "<html><script>alert(1)</script></html>");
    await expect(resolveImageUri(file)).rejects.toThrow();
  });

  it("refuses a private key renamed to .png", async () => {
    const file = path.join(root, "key.png");
    fs.writeFileSync(file, "-----BEGIN RSA PRIVATE KEY-----");
    await expect(resolveImageUri(file)).rejects.toThrow();
  });
});

describe("data: URIs are capped", () => {
  it("refuses an oversized inline data: URI", async () => {
  const huge = "data:image/png;base64," + "A".repeat(MAX_IMAGE_BYTES * 2);
  await expect(resolveImageUri(huge)).rejects.toThrow();
});

  it("still passes a small data: URI through", async () => {
  const ok = "data:image/png;base64," + PNG_1PX.toString("base64");
  expect(await resolveImageUri(ok)).toBe(ok);
});
});

describe("http(s) URLs pass through", () => {
  it("is untouched", async () => {
  const url = "https://example.com/pic.png";
  expect(await resolveImageUri(url)).toBe(url);
});
});

describe("resolveImageUris", () => {
  it("resolves a mixed list", async () => {
    const file = path.join(root, "pic.png");
    fs.writeFileSync(file, PNG_1PX);
    const out = await resolveImageUris([file, "https://example.com/a.png"]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("https://example.com/a.png");
  });
});
