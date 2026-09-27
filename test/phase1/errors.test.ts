import http from "node:http";
import { describe, expect, it } from "vitest";
import { LmStudioClient } from "../../src/lmstudio/client.js";
import { sendJson, sendText, startMockLmStudio } from "./mockServer.js";
import { listModelsFixture } from "./fixtures.js";
import type { NanitesError } from "../../src/helpers/errors.js";

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function codeOf(err: unknown): string {
  return (err as NanitesError).code;
}

describe("LmStudioClient — distinguishable failure modes", () => {
  it("connection refused yields connection_refused (retryable)", async () => {
    const port = await freePort();
    const client = new LmStudioClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2_000 });
    await expect(client.listModels()).rejects.toMatchObject({ code: "connection_refused", retryable: true });
  });

  it("a hung call yields timeout (retryable)", async () => {
    const mock = await startMockLmStudio((_req, res) => {
      setTimeout(() => sendJson(res, 200, listModelsFixture), 500);
    });
    try {
      const client = new LmStudioClient({ baseUrl: mock.url, timeoutMs: 150 });
      await expect(client.listModels()).rejects.toMatchObject({ code: "timeout", retryable: true });
    } finally {
      await mock.close();
    }
  });

  it("4xx yields http_client_error (not retryable) with status in details", async () => {
    const mock = await startMockLmStudio((_req, res) => sendJson(res, 404, { error: "model not found" }));
    try {
      const client = new LmStudioClient({ baseUrl: mock.url });
      const err = await client.listModels().catch((e: unknown) => e) as NanitesError;
      expect(codeOf(err)).toBe("http_client_error");
      expect(err.retryable).toBe(false);
      expect(err.details?.status).toBe(404);
    } finally {
      await mock.close();
    }
  });

  it("5xx yields http_server_error (retryable) with status in details", async () => {
    const mock = await startMockLmStudio((_req, res) => sendJson(res, 500, { error: "boom" }));
    try {
      const client = new LmStudioClient({ baseUrl: mock.url });
      const err = await client.listModels().catch((e: unknown) => e) as NanitesError;
      expect(codeOf(err)).toBe("http_server_error");
      expect(err.retryable).toBe(true);
      expect(err.details?.status).toBe(500);
    } finally {
      await mock.close();
    }
  });

  it("malformed JSON body yields malformed_json (not retryable)", async () => {
    const mock = await startMockLmStudio((_req, res) => sendText(res, 200, "this is not json"));
    try {
      const client = new LmStudioClient({ baseUrl: mock.url });
      await expect(client.listModels()).rejects.toMatchObject({ code: "malformed_json", retryable: false });
    } finally {
      await mock.close();
    }
  });

  it("all five codes are mutually distinguishable", () => {
    const codes = ["connection_refused", "timeout", "http_client_error", "http_server_error", "malformed_json"];
    expect(new Set(codes).size).toBe(codes.length);
  });
});
