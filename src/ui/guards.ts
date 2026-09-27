/**
 * Dashboard request guards.
 *
 * The dashboard binds 127.0.0.1 by default and holds the user LM Studio API
 * token and cloud provider keys. It had no authorization at all:
 * `isLoopbackRequest` decided only whether to mask secrets, and every route was
 * reachable by anything that could open a socket to the port. Two gaps followed.
 *
 *   1. DNS rebinding. An attacker page on a domain resolving to 127.0.0.1
 *      arrives as a *loopback* request, so the masking check said "local" and
 *      handed it the unmasked `endpoint.auth_token`. The browser sent that Host
 *      header, not a loopback one.
 *   2. Cross-site mutation. Every mutating route was a plain POST, so a page
 *      the user merely visited could fire one cross-origin (no preflight for
 *      text/plain) and delete a profile, wipe history, or turn Broadcast on.
 *
 * Pure functions, unit-testable without a socket. Host and Origin are separate:
 * Host applies to every request, Origin only to mutations, and merging them
 * would force each to carry the other condition.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Header a LAN peer may use to supply the mutating token. */
export const LAN_TOKEN_HEADER = "x-nanites-lan-token";

/** Hostnames always accepted, regardless of bind mode. */
// Note: splitHostHeader strips IPv6 brackets, so the literal here is the
// *unbracketed* form. A bracketed "[::1]" never reaches the set.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface GuardOptions {
  /** The port the server is *currently* bound to. Read live: Broadcast rebinds
   * to an ephemeral port, and a value captured at boot would 403 the rebind. */
  port: number;
  /** LAN hostnames accepted in addition to loopback. Empty unless Broadcast is
   * on — an empty list means LAN access fails closed. */
  lanHosts: readonly string[];
}

/**
 * Split a Host header into hostname and optional port, handling the bracketed
 * IPv6 form. Returns null when missing or unparseable: a client that omits Host
 * is exactly the rebinding vector, so it is not allowed.
 */
function splitHostHeader(raw: string): { hostname: string; port?: number } | null {
  if (!raw) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  if (bracketed) {
    const inner = bracketed[1] ?? "";
    const portText = bracketed[2];
    return portText ? { hostname: inner, port: Number(portText) } : { hostname: inner };
  }
  // At most one colon, which must introduce a numeric port. A bare unbracketed
  // IPv6 address has several colons and is rejected.
  const parts = raw.split(":");
  if (parts.length > 2) return null;
  const hostname = parts[0] ?? "";
  if (!hostname) return null;
  if (parts.length === 2) {
    const portText = parts[1] ?? "";
    if (!/^\d+$/.test(portText)) return null;
    return { hostname, port: Number(portText) };
  }
  return { hostname };
}

/**
 * True when a request Host header names this dashboard.
 *
 * Loopback is always allowed. A LAN address is allowed only while Broadcast is
 * on, so switching Broadcast off immediately withdraws LAN access. When a port
 * is present it must match the live bind — otherwise 127.0.0.1:9999 would be
 * accepted by a server on :4700 and the port check would buy nothing.
 */
export function isAllowedHostHeader(raw: string | undefined, opts: GuardOptions): boolean {
  const split = splitHostHeader(raw ?? "");
  if (!split) return false;
  if (split.port !== undefined && split.port !== opts.port) return false;
  const host = split.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return opts.lanHosts.some((lan) => lan.toLowerCase() === host);
}

/**
 * True when a mutation Origin is same-origin (or absent).
 *
 * An absent Origin is allowed: curl, the MCP server, and the test suite all
 * issue bare requests and none can be driven by a web page. Browsers always send
 * Origin on a cross-origin POST, so requiring it *when present* blocks the
 * attack without breaking non-browser clients. `Origin: null` is rejected
 * outright — that is what a sandboxed iframe or a data: page sends.
 */
export function isAllowedOrigin(raw: string | undefined, opts: GuardOptions): boolean {
  if (raw === undefined) return true;
  if (raw === "null" || raw === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // A same-origin Origin carries the port the page was served from, so a
  // mismatch means a different origin even when the hostname is loopback.
  if (parsed.port && Number(parsed.port) !== opts.port) return false;
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return opts.lanHosts.some((lan) => lan.toLowerCase() === host);
}

/** Fresh 32-char base64url LAN token. Never persisted — see startUiServer. */
export function newLanToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Constant-time token comparison that tolerates a length mismatch. */
export function tokensMatch(a: string | undefined, b: string): boolean {
  if (!a) return false;
  // timingSafeEqual throws on unequal lengths, so compare fixed-size digests
  // rather than leaking the mismatch through an exception.
  const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Reject an outbound URL a caller supplied, so a dashboard route cannot be
 * turned into a request forger against loopback, link-local (cloud metadata at
 * 169.254.169.254), or private ranges. Used by the provider ping route and the
 * provider-key `gateway_url` write path.
 */
export function assertOutboundUrl(raw: unknown): { ok: true; url: URL } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "url must be a non-empty string" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "url is not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "url must use http or https" };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, error: "url must not target localhost" };
  }
  if (isPrivateV4(host)) {
    return { ok: false, error: "url must not target a loopback, link-local, or private address" };
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return { ok: false, error: "url must not target a loopback, link-local, or private address" };
  }
  // Plaintext to a non-loopback host puts the bearer token on the wire in the
  // clear, so require TLS for anything not explicitly local.
  if (url.protocol === "http:" && host !== "127.0.0.1") {
    return { ok: false, error: "url must use https unless it targets 127.0.0.1" };
  }
  return { ok: true, url };
}

/** True for loopback, link-local, and RFC1918 IPv4 literals. */
function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0) return true; // 0.0.0.0/8 — this host
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Zod form of `assertOutboundUrl`, for schemas that accept a caller-supplied
 * URL. A provider `gateway_url` is the same class of input as the ping
 * route: it decides where the provider API key is sent, so an http:// or
 * private-range value would hand the key to an arbitrary host.
 */
export const outboundUrlSchema = z.string().superRefine((raw, ctx) => {
  const checked = assertOutboundUrl(raw);
  if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.error });
});
