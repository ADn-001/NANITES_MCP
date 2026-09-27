import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LmStudioClient } from "../../src/lmstudio/client.js";
import { sendJson, startMockLmStudio, type MockLmStudio } from "./mockServer.js";
import {
  chatResponseFixture,
  downloadModelFixture,
  downloadStatusFixture,
  listModelsFixture,
  loadModelFixture,
  unloadModelFixture,
} from "./fixtures.js";

function standardHandler() {
  let lastBody: string | null = null;
  const handler = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    lastBody = body;
    const url = new URL(req.url ?? "/", "http://mock");
    switch (url.pathname) {
      case "/api/v1/models":
        return sendJson(res, 200, listModelsFixture);
      case "/api/v1/models/load":
        return sendJson(res, 200, loadModelFixture);
      case "/api/v1/models/unload":
        return sendJson(res, 200, unloadModelFixture);
      case "/api/v1/models/download":
        return sendJson(res, 200, downloadModelFixture);
      case "/api/v1/models/download/status/job_493c7c9ded":
        return sendJson(res, 200, downloadStatusFixture);
      case "/api/v1/chat":
        return sendJson(res, 200, chatResponseFixture);
      default:
        return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
    }
  };
  return { handler, getLastBody: () => lastBody };
}

describe("LmStudioClient — one wrapper per endpoint", () => {
  let mock: MockLmStudio;
  let getLastBody: () => string | null;
  let client: LmStudioClient;

  beforeAll(async () => {
    const factory = standardHandler();
    getLastBody = factory.getLastBody;
    mock = await startMockLmStudio(factory.handler);
    client = new LmStudioClient({ baseUrl: mock.url });
  });

  afterAll(async () => {
    await mock.close();
  });

  it("listModels parses the documented GET /api/v1/models response", async () => {
    const result = await client.listModels();
    expect(result).toEqual(listModelsFixture);
  });

  it("getLoadedModel returns only models with loaded instances", async () => {
    const loaded = await client.getLoadedModel();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.key).toBe("gemma-3-270m-it-qat");
    expect(loaded[0]!.loaded_instances[0]!.id).toBe("gemma-3-270m-it-qat");
  });

  it("loadModel sends the model and parses the documented response", async () => {
    const result = await client.loadModel({ model: "openai/gpt-oss-20b", context_length: 16384, flash_attention: true, echo_load_config: true });
    expect(result).toEqual(loadModelFixture);
    const sent = JSON.parse(getLastBody()!) as Record<string, unknown>;
    expect(sent.model).toBe("openai/gpt-oss-20b");
    expect(sent.context_length).toBe(16384);
  });

  it("unloadModel parses the documented response", async () => {
    const result = await client.unloadModel({ instance_id: "openai/gpt-oss-20b" });
    expect(result).toEqual(unloadModelFixture);
  });

  it("downloadModel parses the documented response", async () => {
    const result = await client.downloadModel({ model: "ibm/granite-4-micro" });
    expect(result).toEqual(downloadModelFixture);
  });

  it("getDownloadStatus parses the documented response", async () => {
    const result = await client.getDownloadStatus("job_493c7c9ded");
    expect(result).toEqual(downloadStatusFixture);
  });

  it("chat (non-streaming) parses the documented response and sent model+input", async () => {
    const { response } = await client.chat("qwen/qwen3-vl-4b", "Describe this image in two sentences", { context_length: 2048, temperature: 0 });
    expect(response).toEqual(chatResponseFixture);
    const sent = JSON.parse(getLastBody()!) as Record<string, unknown>;
    expect(sent.model).toBe("qwen/qwen3-vl-4b");
    expect(sent.input).toBe("Describe this image in two sentences");
    expect(sent.stream).toBeUndefined();
  });

  it("sends the auth bearer token when configured", async () => {
    const seen: string[] = [];
    const m2 = await startMockLmStudio((req, res) => {
      seen.push(req.headers.authorization ?? "");
      sendJson(res, 200, listModelsFixture);
    });
    try {
      const authed = new LmStudioClient({ baseUrl: m2.url, authToken: "secret-token" });
      await authed.listModels();
      expect(seen[0]).toBe("Bearer secret-token");
    } finally {
      await m2.close();
    }
  });
});
