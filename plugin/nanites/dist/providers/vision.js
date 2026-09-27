/**
 * Vision input resolution. A vision delegation passes images
 * to a cloud model as OpenAI `image_url` content parts. Each `images[]` element
 * is either a local path (read server-side, bounded, and base64-encoded into a
 * `data:` URI), an `http(s)` URL, or a pre-existing `data:` URI — the last two
 * pass through untouched. Unknown schemes are refused before anything is sent.
 */
import { open as fspOpen } from "node:fs/promises";
import { NanitesError } from "../helpers/errors.js";
import { resolveWithinRoot } from "./fsTools.js";
const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
};
/** Per-image cap for local-path reads (~20 MB raw before base64 expansion). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const VISION_FALLBACK_TEXT = "Describe what is in this image.";
export function isDataUri(value) {
    return value.startsWith("data:");
}
/**
 * Directories a local image may be read from. Vision delegation is the one
 * path that took an arbitrary absolute path: resolveLocalPath stat-ed and
 * read whatever it was handed, so a delegation with
 * images: ["~/.ssh/id_rsa"] base64-ed it and sent it to a provider. It never
 * called resolveWithinRoot and never imported fsTools.
 */
export function visionRoots() {
    const configured = process.env.NANITES_VISION_ROOTS?.split(";")
        .map((r) => r.trim())
        .filter(Boolean);
    if (configured && configured.length > 0)
        return configured;
    return [process.cwd()];
}
/** Magic-byte signatures, so a renamed .png cannot smuggle a non-image. */
function sniffImageMime(buf) {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return "image/png";
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return "image/jpeg";
    if (buf.length >= 6 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a"))
        return "image/gif";
    if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
        return "image/webp";
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d)
        return "image/bmp";
    return null;
}
/**
 * Read a local image, confined to an allowed root.
 *
 * Async, and stat-ed through the same file handle as the read, so the size
 * cap cannot be raced by swapping the file and the event loop is not blocked
 * by a 20 MB synchronous read.
 */
async function readLocalImage(input) {
    const roots = visionRoots();
    let absPath = null;
    for (const root of roots) {
        const resolved = resolveWithinRoot(root, input);
        if (resolved.ok) {
            absPath = resolved.absPath;
            break;
        }
    }
    if (absPath === null) {
        throw new NanitesError({
            code: "image_outside_allowed_root",
            message: "Image path is outside the allowed vision roots",
            retryable: false,
        });
    }
    let handle;
    try {
        handle = await fspOpen(absPath, "r");
    }
    catch {
        throw new NanitesError({
            code: "image_not_found",
            message: "Image path does not exist or is unreadable",
            retryable: false,
        });
    }
    try {
        const stat = await handle.stat();
        if (stat.size > MAX_IMAGE_BYTES) {
            throw new NanitesError({
                code: "image_too_large",
                message: `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB cap`,
                retryable: false,
            });
        }
        const data = Buffer.from(await handle.readFile());
        const sniffed = sniffImageMime(data);
        if (sniffed === null) {
            throw new NanitesError({
                code: "image_not_an_image",
                message: "File content does not look like a supported image",
                retryable: false,
            });
        }
        return `data:${sniffed};base64,${data.toString("base64")}`;
    }
    finally {
        await handle.close().catch(() => { });
    }
}
/** Resolve a single `images[]` element to a wire-ready image URL. */
/**
 * Largest data: URI accepted, in characters. The 20 MB cap only ever applied
 * to the local-path branch, so a caller could inline an arbitrarily large
 * base64 blob and bypass it entirely.
 */
const MAX_DATA_URI_CHARS = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 1024;
export async function resolveImageUri(input) {
    const value = input.trim();
    if (isDataUri(value)) {
        if (value.length > MAX_DATA_URI_CHARS) {
            throw new NanitesError({
                code: "image_too_large",
                message: "Inline data: URI exceeds the size cap",
                retryable: false,
            });
        }
        return value;
    }
    if (/^https?:\/\//i.test(value))
        return value;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        throw new NanitesError({
            code: "unsupported_image_source",
            message: "Image sources must be a local path, http(s) URL, or data: URI",
            retryable: false,
        });
    }
    return readLocalImage(value);
}
export async function resolveImageUris(inputs) {
    const out = [];
    for (const input of inputs)
        out.push(await resolveImageUri(input));
    return out;
}
/** Build a user-message content value from a brief + resolved image URLs. */
export function buildVisionContent(brief, imageUrls) {
    const parts = [];
    const text = brief.trim() || VISION_FALLBACK_TEXT;
    parts.push({ type: "text", text });
    for (const url of imageUrls) {
        parts.push({ type: "image_url", image_url: { url } });
    }
    return parts;
}
