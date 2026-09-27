/**
 * Phase 60 gate — dashboard request guards.
 *
 * Pure-function tests for the Host / Origin / LAN-token / outbound-URL checks
 * that close the DNS-rebinding and cross-site-mutation surfaces. No server and
 * no socket: these are the pieces the HTTP tests then exercise end to end.
 */
import { describe, expect, it } from "vitest";
import {
  assertOutboundUrl,
  isAllowedHostHeader,
  isAllowedOrigin,
  newLanToken,
  tokensMatch,
} from "../../src/ui/guards.js";

const OPTS = { port: 4700, lanHosts: [] as string[] };
const BROADCAST = { port: 4700, lanHosts: ["192.168.1.50"] };

describe("isAllowedHostHeader", () => {
  it("rejects a missing Host header (the rebinding vector)", () => {
    expect(isAllowedHostHeader(undefined, OPTS)).toBe(false);
    expect(isAllowedHostHeader("", OPTS)).toBe(false);
  });

  it("rejects an attacker-controlled Host", () => {
    expect(isAllowedHostHeader("evil.example", OPTS)).toBe(false);
    expect(isAllowedHostHeader("evil.example:4700", OPTS)).toBe(false);
  });

  it("rejects a Host whose port does not match the live bind", () => {
    // Without the port check, 127.0.0.1 on any port would pass.
    expect(isAllowedHostHeader("127.0.0.1:9999", OPTS)).toBe(false);
    expect(isAllowedHostHeader("127.0.0.1:4700", OPTS)).toBe(true);
  });

  it("accepts loopback in every legal spelling", () => {
    // RFC 3986 requires an IPv6 literal in Host to be bracketed, so a bare
    // "::1" is not a legal header value and is rejected in the test below.
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(isAllowedHostHeader(host, OPTS)).toBe(true);
      expect(isAllowedHostHeader(`${host}:4700`, OPTS)).toBe(true);
    }
  });

  it("accepts a LAN host only while Broadcast is on", () => {
    expect(isAllowedHostHeader("192.168.1.50:4700", OPTS)).toBe(false);
    expect(isAllowedHostHeader("192.168.1.50:4700", BROADCAST)).toBe(true);
  });

  it("rejects an unbracketed IPv6 literal rather than mis-splitting it", () => {
    // A bare "::1" has several colons; splitting on the first would treat ":1"
    // as a port. Rejecting is the safe reading — no real client sends it.
    expect(isAllowedHostHeader("::1", OPTS)).toBe(false);
    expect(isAllowedHostHeader("fe80::1", OPTS)).toBe(false);
    expect(isAllowedHostHeader("[fe80::1]:4700", OPTS)).toBe(false);
    expect(isAllowedHostHeader("[::1]:4700", OPTS)).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts an absent Origin (curl, MCP, tests — no browser can be driving it)", () => {
    expect(isAllowedOrigin(undefined, OPTS)).toBe(true);
  });

  it("rejects the literal Origin 'null' (sandboxed iframe, data: page)", () => {
    expect(isAllowedOrigin("null", OPTS)).toBe(false);
  });

  it("rejects a cross-origin Origin", () => {
    expect(isAllowedOrigin("http://evil.example", OPTS)).toBe(false);
    expect(isAllowedOrigin("https://evil.example:4700", OPTS)).toBe(false);
  });

  it("rejects a loopback Origin on a different port", () => {
    // Same hostname, different origin: still cross-origin.
    expect(isAllowedOrigin("http://127.0.0.1:9999", OPTS)).toBe(false);
  });

  it("accepts loopback and LAN origins in scope", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4700", OPTS)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4700", OPTS)).toBe(true);
    expect(isAllowedOrigin("http://192.168.1.50:4700", OPTS)).toBe(false);
    expect(isAllowedOrigin("http://192.168.1.50:4700", BROADCAST)).toBe(true);
  });
});

describe("LAN token", () => {
  it("is 32 base64url chars and unique per call", () => {
    const a = newLanToken();
    const b = newLanToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it("matches only the identical token", () => {
    const token = newLanToken();
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch("wrong", token)).toBe(false);
    expect(tokensMatch(undefined, token)).toBe(false);
    // Length mismatch must not throw.
    expect(tokensMatch("short", token)).toBe(false);
  });
});

describe("assertOutboundUrl", () => {
  it("rejects the cloud metadata endpoint (SSRF)", () => {
    expect(assertOutboundUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });

  it("rejects loopback and private ranges", () => {
    for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "172.16.0.1", "192.168.1.1", "0.0.0.0"]) {
      expect(assertOutboundUrl(`http://${host}/v1/models`).ok).toBe(false);
    }
  });

  it("rejects non-http schemes", () => {
    expect(assertOutboundUrl("file:///etc/passwd").ok).toBe(false);
    expect(assertOutboundUrl("gopher://evil.example").ok).toBe(false);
  });

  it("requires https for a non-loopback host (no cleartext bearer token)", () => {
    expect(assertOutboundUrl("http://api.example.com/v1").ok).toBe(false);
    expect(assertOutboundUrl("https://api.example.com/v1").ok).toBe(true);
  });

  it("rejects a malformed or empty url", () => {
    expect(assertOutboundUrl("").ok).toBe(false);
    expect(assertOutboundUrl("not a url").ok).toBe(false);
    expect(assertOutboundUrl(42).ok).toBe(false);
  });
});
