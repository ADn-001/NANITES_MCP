/**
 * Phase 6 gate — ntfy notifications (test suite items 2-3).
 *
 * Covers default resolution (topic-only -> https://ntfy.sh, no auth), explicit
 * server_url/access_token override, tag serialization, and the fire-and-forget
 * contract (a failed push never throws). The integration case POSTs against a
 * real local mock so the full request (URL, headers, body) is asserted on the
 * wire.
 */
import { describe, expect, it } from "vitest";
import { buildNtfyRequest, sendNtfy } from "../../src/notify/ntfy.js";
import { sendJson, startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import type { NtfyConfig } from "../../src/storage/profileDefaults.js";

const base: NtfyConfig = { topic: "nanites", server_url: "https://ntfy.sh", access_token: null };

describe("Phase 6 gate — buildNtfyRequest", () => {
  it("topic-only: public ntfy.sh, no auth header", () => {
    const req = buildNtfyRequest(base, "hello");
    expect(req.url).toBe("https://ntfy.sh/nanites");
    expect(req.body).toBe("hello");
    expect(req.headers["Authorization"]).toBeUndefined();
    expect(req.headers["Content-Type"]).toBe("text/plain");
  });

  it("explicit server_url + access_token override both defaults", () => {
    const req = buildNtfyRequest(
      { topic: "alerts", server_url: "https://push.example.com/", access_token: "sekret" },
      "hello",
    );
    expect(req.url).toBe("https://push.example.com/alerts");
    expect(req.headers["Authorization"]).toBe("Bearer sekret");
  });

  it("tags serialize into the Tags header", () => {
    const req = buildNtfyRequest(base, "hello", ["warning", "siren"]);
    expect(req.headers["Tags"]).toBe("warning,siren");
  });

  it("empty tags emit no Tags header", () => {
    const req = buildNtfyRequest(base, "hello", []);
    expect(req.headers["Tags"]).toBeUndefined();
  });
});

describe("Phase 6 gate — sendNtfy fire-and-forget", () => {
  it("no topic configured: silent no-op, never throws", async () => {
    const result = await sendNtfy({ ...base, topic: null }, "hello");
    expect(result).toEqual({ sent: false, reason: "no_topic" });
  });

  it("unreachable server: caught, no throw, push_failed", async () => {
    const dead = await startMockLmStudio((_req, res) => sendJson(res, 200, {}));
    await dead.close(); // release the port -> ECONNREFUSED
    const result = await sendNtfy(
      { topic: "nanites", server_url: dead.url, access_token: null },
      "hello",
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("push_failed");
  });

  it("integration: POST reaches the server with correct URL, headers, body; 2xx -> sent", async () => {
    let captured: { url: string; method: string; headers: Record<string, string | undefined>; body: string } | null = null;
    const mock: MockLmStudio = await startMockLmStudio((req, res, body) => {
      captured = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: {
          "Content-Type": req.headers["content-type"],
          Authorization: req.headers["authorization"],
          Tags: req.headers["tags"],
        },
        body,
      };
      sendJson(res, 200, { id: "x" });
    });

    const result = await sendNtfy(
      { topic: "build-finished", server_url: mock.url, access_token: "tok" },
      "all green",
      ["white_check_mark"],
    );
    await mock.close();

    expect(result).toEqual({ sent: true, reason: null });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toBe("/build-finished");
    expect(captured!.headers["Content-Type"]).toBe("text/plain");
    expect(captured!.headers["Authorization"]).toBe("Bearer tok");
    expect(captured!.headers["Tags"]).toBe("white_check_mark");
    expect(captured!.body).toBe("all green");
  });

  it("non-2xx response: reported as http_<status>, still no throw", async () => {
    const mock: MockLmStudio = await startMockLmStudio((_req, res) => sendJson(res, 429, { error: "rate" }));
    const result = await sendNtfy({ topic: "t", server_url: mock.url, access_token: null }, "hi");
    await mock.close();
    expect(result).toEqual({ sent: false, reason: "http_429" });
  });
});
