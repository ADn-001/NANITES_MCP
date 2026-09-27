#!/usr/bin/env tsx
/**
 * LIVE SMOKE TEST — NOT part of CI, NOT gate-blocking.
 *
 * Runs the Phase 1 wrapper layer against a real LM Studio instance.
 * If LM Studio is unreachable the script prints a SKIP and exits 0; a
 * reachable-but-failing check exits 1 so real failures are visible.
 *
 * Usage:
 *   NANITES_LM_BASE_URL=http://localhost:1234 \
 *   NANITES_LM_TOKEN=... \
 *   NANITES_LM_MODEL=ibm/granite-4-micro \
 *   npm run live-smoke
 */
import { LmStudioClient } from "../src/lmstudio/client.js";
import { NanitesError } from "../src/helpers/errors.js";

const baseUrl = process.env.NANITES_LM_BASE_URL ?? "http://localhost:1234";
const token = process.env.NANITES_LM_TOKEN ?? null;
const model = process.env.NANITES_LM_MODEL ?? null;
const downloadJob = process.env.NANITES_LM_DOWNLOAD_JOB ?? null;

const client = new LmStudioClient({ baseUrl, authToken: token, timeoutMs: 15_000 });

async function main(): Promise<number> {
  let models;
  try {
    models = await client.listModels();
  } catch (err) {
    if (err instanceof NanitesError && (err.code === "connection_refused" || err.code === "network_error")) {
      console.log(`SKIP: LM Studio not reachable at ${baseUrl} (${err.code}). This is a live smoke test; run it with LM Studio's server up.`);
      return 0;
    }
    throw err;
  }

  const loaded = await client.getLoadedModel();
  console.log(`OK  listModels: ${models.models.length} model(s) available; ${loaded.length} loaded`);

  let chatModel: string | null = model ?? loaded[0]?.key ?? null;
  let loadedInstance: string | null = null;

  if (model) {
    const load = await client.loadModel({ model });
    loadedInstance = load.instance_id;
    chatModel = model;
    console.log(`OK  loadModel "${model}" -> instance ${load.instance_id} in ${load.load_time_seconds.toFixed(2)}s`);
  }

  if (!chatModel) {
    console.log(`SKIP: no model specified (NANITES_LM_MODEL) and none loaded; chat check skipped.`);
  } else {
    const { response, events } = await client.chat(chatModel, "Reply with the single word: pong", { stream: true });
    const text = response.output.find((o) => o.type === "message")?.content ?? "<no message>";
    console.log(`OK  chat(stream) reassembled from ${events.length} events, ${response.stats.total_output_tokens} output tokens: ${JSON.stringify(text.slice(0, 80))}`);
  }

  if (loadedInstance) {
    await client.unloadModel({ instance_id: loadedInstance });
    console.log(`OK  unloadModel "${loadedInstance}"`);
  }

  if (downloadJob) {
    const status = await client.getDownloadStatus(downloadJob);
    console.log(`OK  getDownloadStatus ${downloadJob}: ${status.status}`);
  }

  console.log("PASS: all live checks succeeded against real LM Studio.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  });
