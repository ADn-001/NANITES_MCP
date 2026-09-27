/**
 * Phase 66 gate — errors must not leak paths or upstream bodies to the
 * orchestrator.
 *
 * CLAUDE.md section 6 forbids absolute local filesystem paths, usernames and
 * machine-specific strings in anything returned to the orchestrator. Three
 * paths violated it: the LM Studio error mappers put a 500-char raw upstream
 * body into `details`, the tool response wrapper returned any non-NanitesError
 * message verbatim, and the provider fetch mapper echoed the full resolved URL
 * — which on the Cloudflare path carries the account id.
 */
import { describe, expect, it } from "vitest";
import { mapHttpStatus, malformedJsonError } from "../../src/lmstudio/errors.js";
import { NanitesError } from "../../src/helpers/errors.js";
import { mapFetchError } from "../../src/providers/errors.js";
import { fail } from "../../src/tools/responses.js";

/** A path shaped like a real LM Studio stack frame. */
const LEAKY = "Error: model load failed at C:\\Users\\testuser\\.lmstudio\\models\\foo.gguf";

describe("LM Studio error mapping (H14)", () => {
  it("does not put a raw HTML body in details", () => {
    const body = "<html><body><pre>" + LEAKY + "</pre></body></html>";
    const err = mapHttpStatus(500, body);
    const details = JSON.stringify(err.details ?? {});
    expect(details).not.toContain("testuser");
    expect(details).not.toContain(".lmstudio");
  });

  it("does not put a raw stack-trace body in details", () => {
    const err = malformedJsonError(LEAKY);
    const details = JSON.stringify(err.details ?? {});
    expect(details).not.toContain("testuser");
    expect(details).not.toContain(".lmstudio");
  });

  it("keeps a short message extracted from a JSON error body", () => {
    const err = mapHttpStatus(400, JSON.stringify({ error: "context length exceeded" }));
    expect(JSON.stringify(err.details ?? {})).toContain("context length exceeded");
  });

  it("still reports the status code", () => {
    expect(mapHttpStatus(503, "").details?.status).toBe(503);
    expect(mapHttpStatus(400, "").retryable).toBe(false);
    expect(mapHttpStatus(500, "").retryable).toBe(true);
  });
});

describe("tool response wrapper (M31)", () => {
  it("does not surface a raw sqlite or fs message", () => {
    const leaky = new Error("SqliteError: unable to open database file C:\\Users\\testuser\\.nanites\\nanites.db");
    const shape = fail(leaky) as { content: Array<{ text: string }> };
    const text = shape.content[0]!.text;
    expect(text).not.toContain("testuser");
    expect(text).not.toContain(".nanites");
    expect(text).toContain("Internal error");
  });

  it("still reports a NanitesError message as authored", () => {
    const err = new NanitesError({ code: "profile_not_found", message: "No profile named x", retryable: false });
    const ok = fail(err);
    expect(JSON.stringify(ok)).toContain("profile_not_found");
  });
});

describe("provider fetch errors (M6)", () => {
  it("does not echo the resolved URL (which carries the account id)", () => {
    const leaky = new Error("fetch failed for https://api.cloudflare.com/client/v4/accounts/abc123def/ai/v1/models");
    const err = mapFetchError(leaky);
    expect(err.message).not.toContain("abc123def");
    expect(err.message).not.toContain("accounts");
  });

  it("still classifies a timeout as retryable", () => {
    const err = mapFetchError(new Error("The operation was aborted"));
    expect(err.retryable).toBe(true);
  });
});
