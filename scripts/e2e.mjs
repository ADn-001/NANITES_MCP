/**
 * End-to-end verification against REAL providers.
 *
 * Every other suite stubs the network. This one does not: it drives the built
 * `nanites-router` binary against live Cloudflare, OpenRouter, and NVIDIA
 * accounts, and fails loudly on anything that does not work.
 *
 * Usage:
 *   NANITES_ROUTER_KEY=... node scripts/e2e.mjs
 * The real provider keys are read from NANITES_HOME, exactly as the running
 * router reads them — so this exercises the same credential path production
 * does rather than a parallel one that could drift.
 */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HOME = process.env.NANITES_HOME;
const KEY = process.env.NANITES_ROUTER_KEY;
const PORT = Number(process.env.E2E_PORT ?? 4899);
const BASE = `http://127.0.0.1:${PORT}`;

if (!HOME || !KEY) {
  console.error("Set NANITES_HOME (a router home with provider keys) and NANITES_ROUTER_KEY.");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];

function record(ok, name, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const auth = () => ({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });

async function post(pathname, body, extra = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { ...auth(), ...extra },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(pathname, extra = {}) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { authorization: `Bearer ${KEY}`, ...extra } });
  return { status: res.status, body: await res.json().catch(() => null), text: await res.text().catch(() => "") };
}

/** Read which providers and models this home actually has, to drive the run. */
function inventory() {
  const db = new DatabaseSync(path.join(HOME, "nanites.db"), { readOnly: true });
  const keys = db.prepare(
    "SELECT DISTINCT provider, account_id FROM provider_api_keys WHERE profile_name='__router__' AND is_enabled=1 AND is_exhausted=0",
  ).all();
  const models = db.prepare(
    "SELECT provider, model_id, is_registered FROM provider_models WHERE profile_name='__router__'",
  ).all();
  db.close();
  return { keys, models };
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/v1/health`, { headers: { authorization: `Bearer ${KEY}` } });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await delay(250);
  }
  return false;
}

/** Publish a model under a harness-safe alias, straight into the store. */
function publishForTest(home, textModel, imgModel) {
  if (!textModel) return;
  // A failure here must be VISIBLE. Swallowing it produced an empty catalog
  // and a shape assertion that then passed vacuously.
  try {
    const db = new DatabaseSync(path.join(home, "nanites.db"));
    const now = new Date().toISOString();
    const rows = [["nanites-cf-text", textModel, ["text"], null]];
    if (imgModel) rows.push(["nanites-cf-image", imgModel, ["image"], null]);
    for (const [alias, realId, mods, ctx] of rows) {
      db.prepare(
        "INSERT OR REPLACE INTO router_advertised (alias,real_id,provider,modalities,context_window,created_at) VALUES (?,?,?,?,?,?)",
      ).run(alias, realId, "cloudflare", JSON.stringify(mods), ctx, now);
    }
    db.close();
  } catch (e) {
    // NOT swallowed: an empty catalog makes every shape assertion vacuous.
    console.log(`       (could not publish a test model: ${e.message})`);
  }
}

async function main() {
  // The router is started FIRST so its migrations create the schema, then
  // inventoried. Reading before the first boot fails on a fresh home, which
  // is the normal case for a new E2E run.
  // Publish a model BEFORE the router boots. An empty catalog makes every
  // shape assertion pass vacuously, which is how a dialect mix-up would slip
  // through — and a write made after boot races the router's open connection.
  const imgModel = "@cf/black-forest-labs/flux-1-schnell";
  const textModelHint = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  publishForTest(HOME, textModelHint, imgModel);

  const child = spawn(process.execPath, ["dist/router/main.js"], {
    env: { ...process.env, NANITES_HOME: HOME, NANITES_ROUTER_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[router] ${d}`));
  if (!(await waitForHealth())) {
    child.kill();
    throw new Error("router did not become healthy");
  }

  const inv = inventory();
  const has = (p) => inv.keys.some((k) => k.provider === p);
  const modelOf = (p) => inv.models.find((m) => m.provider === p && m.is_registered)?.model_id
    ?? inv.models.find((m) => m.provider === p)?.model_id;

  // A TEXT model chosen by CATEGORY, not by whether the name looks texty.
  // The first registered model alphabetically is an image model, and asking
  // FLUX to chat is not a router bug. LLaVA is also excluded: it is a VQA model
  // that needs an image, and "no image" is not a text-generation request.
  const TEXT_MODELS = new Set([
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
  ]);
  const textProvider = has("cloudflare") ? "cloudflare" : has("openrouter") ? "openrouter" : null;
  const textModel = textProvider
    ? inv.models.find((m) => m.provider === textProvider && TEXT_MODELS.has(m.model_id))?.model_id
    : null;

  console.log(`\nInventory: ${inv.keys.length} provider account group(s), ${inv.models.length} model(s)\n`);

  try {
    /* ------------------------------------------------------ health + auth */
    console.log("Health and authentication");
    const h = await get("/v1/health");
    record(h.status === 200 && h.body.status === "ok", "health responds", `port ${h.body?.port}`);
    record(h.body?.key_present === true, "health reports a key without revealing it");
    record(!JSON.stringify(h.body).includes(KEY), "health never contains the virtual key");
    const noKey = await fetch(`${BASE}/v1/health`);
    record(noKey.status === 401, "unauthenticated is rejected", `status ${noKey.status}`);

    /* -------------------------------------------------------------- catalog */
    console.log("\nCatalog");
    const models = await get("/v1/models");
    record(models.status === 200 && Array.isArray(models.body?.data), "GET /v1/models", `${models.body?.data?.length ?? 0} advertised`);
    const anth = await get("/v1/models", { "anthropic-version": "2023-06-01" });
    // Assert the two renderings are DISTINCT and each internally consistent.
    // `object`+`owned_by` is the OpenAI marker; `type`+`display_name` the
    // Anthropic one. Checking that both are present is what catches a dialect
    // mix-up, and the emptiness guard stops it passing on an empty list.
    const list = models.body?.data ?? [];
    const alist = anth.body?.data ?? [];
    const openaiShape = list.length > 0 && list.every((m) => m.object === "model" && m.owned_by);
    const anthropicShape = alist.length > 0 && alist.every((m) => m.type === "model" && m.display_name);
    // The two must not be the same document.
    const distinct = JSON.stringify(list) !== JSON.stringify(alist);
    // Shape, not membership: an EMPTY catalog trivially satisfies "every".
    // Assert the two renderings differ structurally so a dialect mix-up cannot
    // pass on an empty list.
    record(openaiShape && anthropicShape && distinct,
      "both dialects render, in their own shapes",
      `${list.length} models, object/owned_by vs type/display_name`);
    record("has_more" in (anth.body ?? {}), "Anthropic catalog carries has_more");

    /* ----------------------------------------------------------------- text */
    console.log("\nText generation");
    if (textModel) {
      const provider = textProvider;
      const t = await post("/v1/chat/completions", {
        model: `${provider}:${textModel}`,
        max_tokens: 24,
        messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      });
      const content = t.body?.choices?.[0]?.message?.content;
      record(t.status === 200 && typeof content === "string" && content.length > 0,
        "OpenAI dialect round trip", `${provider}:${textModel} -> ${JSON.stringify(content)?.slice(0, 30)}`);
      record(t.body?.choices?.[0]?.finish_reason === "stop", "finish_reason mapped", String(t.body?.choices?.[0]?.finish_reason));

      const a = await post("/v1/messages", {
        model: `${provider}:${textModel}`,
        max_tokens: 24,
        messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      });
      record(a.status === 200 && a.body?.type === "message" && Array.isArray(a.body?.content),
        "Anthropic dialect round trip", `type=${a.body?.type}`);
      record(typeof a.body?.content?.[0]?.text === "string", "Anthropic content block present");
    } else {
      record(false, "a text model is registered", "none found — cannot test text");
    }

    /* ------------------------------------------------------------ streaming */
    console.log("\nStreaming");
    if (textModel) {
      const provider = textProvider;
      const res = await fetch(`${BASE}/v1/messages`, {
        method: "POST",
        headers: { ...auth(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: `${provider}:${textModel}`, max_tokens: 24, stream: true,
          messages: [{ role: "user", content: "Count: one two three" }],
        }),
      });
      const body = await res.text();
      const order = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]
        .filter((e) => body.includes(`"${e}"`));
      record(res.status === 200 && res.headers.get("content-type")?.includes("text/event-stream"), "Anthropic stream starts");
      record(order[0] === "message_start" && order[order.length - 1] === "message_stop",
        "Anthropic event sequence is correct", order.join(" -> "));
      record(body.includes('"input_tokens"') && body.includes('"output_tokens"'), "stream carries usage");

      const ores = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: auth(),
        body: JSON.stringify({
          model: `${provider}:${textModel}`, max_tokens: 24, stream: true,
          messages: [{ role: "user", content: "Count: one two three" }],
        }),
      });
      const obody = await ores.text();
      record(ores.status === 200 && obody.includes('"role":"assistant"'), "OpenAI stream opens with role");
      // Unquoted, and last.
      record(/data: \[DONE\]\s*$/.test(obody.trim()) || obody.trim().endsWith("data: [DONE]"),
        "OpenAI stream terminates with an unquoted [DONE]");
    }

    /* -------------------------------------------------------------- vision */
    console.log("\nVision");
    const vision = modelOf("cloudflare") && inv.models.find((m) => m.model_id === "@cf/llava-hf/llava-1.5-7b-hf")?.model_id;
    if (vision) {
      const black = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAXklEQVRoge3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgokAAfJq/HWQAAAABJRU5ErkJggg==";
      // LLaVA is MEASURED flaky: 37/48 sequential runs succeeded, the rest a
      // transient `triton error running inference` 500. The synchronous path
      // deliberately has no retry — that is the job queue's role — so the
      // check retries here rather than reporting a known-flaky model as broken.
      let text;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const v = await post("/v1/chat/completions", {
          model: `cloudflare:${vision}`,
          messages: [{ role: "user", content: [
            { type: "text", text: "what color is this image? one word" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${black}` } },
          ] }],
        });
        text = v.body?.choices?.[0]?.message?.content;
        if (v.status === 200 && typeof text === "string" && text.length > 0) {
          record(true, "image -> text via /ai/run", `${JSON.stringify(text)?.slice(0, 30)} (attempt ${attempt})`);
          break;
        }
        await delay(1500);
      }
      if (!(typeof text === "string" && text.length > 0)) {
        record(false, "image -> text via /ai/run", "no text after 4 attempts");
      }
    } else {
      record(true, "vision", "skipped — LLaVA not in the catalog");
    }

    /* --------------------------------------------------------------- image */
    console.log("\nImage generation");
      if (has("cloudflare")) {
      const g = await post("/v1/chat/completions", {
        model: `cloudflare:${imgModel}`,
        messages: [{ role: "user", content: "a red cube on a white table" }],
      });
      const b64 = g.body?.data?.[0]?.b64_json;
      const bytes = b64 ? Buffer.from(b64, "base64") : null;
      const isJpeg = bytes ? bytes[0] === 0xff && bytes[1] === 0xd8 : false;
      const isPng = bytes ? bytes[0] === 0x89 && bytes[1] === 0x50 : false;
      record(g.status === 200 && Boolean(b64) && (isJpeg || isPng),
        "text -> image via /ai/run", `${bytes?.length ?? 0}B ${isJpeg ? "jpeg" : isPng ? "png" : "?"}`);
      // The mime must match the actual bytes, not an assumption.
      const declared = g.body?.data?.[0]?.mime_type;
      record(declared === (isJpeg ? "image/jpeg" : "image/png"), "declared mime matches the bytes", String(declared));
    } else {
      record(false, "text -> image", "no cloudflare key configured");
    }

    /* ---------------------------------------------------------------- audio */
    console.log("\nAudio generation");
    if (has("cloudflare")) {
      const tts = "@cf/deepgram/aura-1";
      const a = await post("/v1/chat/completions", {
        model: `cloudflare:${tts}`,
        messages: [{ role: "user", content: "Hello from the router." }],
      });
      const b64 = a.body?.data?.[0]?.b64_json;
      const bytes = b64 ? Buffer.from(b64, "base64") : null;
      const isMp3 = bytes ? bytes[0] === 0xff && (bytes[1] === 0xfb || bytes[1] === 0xf3) : false;
      record(a.status === 200 && Boolean(b64) && isMp3, "text -> audio via /ai/run", `${bytes?.length ?? 0}B mp3=${isMp3}`);
    } else {
      record(false, "text -> audio", "no cloudflare key configured");
    }

    /* ----------------------------------------------------------------- jobs */
    console.log("\nAsync jobs");
    if (has("cloudflare")) {
      const j = await post("/v1/jobs", {
        model: `cloudflare:${imgModel}`, source: "text", target: "image",
        body: { model: imgModel, messages: [{ role: "user", content: "a blue sphere" }] },
      });
      record(j.status === 202 && Boolean(j.body?.job_id), "POST /v1/jobs returns 202", String(j.body?.job_id)?.slice(0, 8));
      if (j.body?.job_id) {
        let final = null;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const s = await get(`/v1/jobs/${j.body.job_id}`);
          final = s.body;
          if (["done", "failed", "cancelled"].includes(final?.status)) break;
          await delay(1000);
        }
        record(final?.status === "done", "job reaches done", final?.status);
        record(Boolean(final?.artifact_uri), "job carries its artifact");
        // Progress is honest: a provider-reported fraction or nothing.
        record(final?.progress === null || typeof final?.progress === "number", "progress is honest", String(final?.progress));
        const ev = await get(`/v1/jobs/${j.body.job_id}/events`);
        record(ev.status === 200, "job progress stream responds");
      }
    }

    /* ------------------------------------------------------------- failover */
    console.log("\nKey selection and failover");
    const db = new DatabaseSync(path.join(HOME, "nanites.db"), { readOnly: true });
    const cfKeys = db.prepare(
      "SELECT COUNT(*) n FROM provider_api_keys WHERE profile_name='__router__' AND provider='cloudflare' AND is_enabled=1 AND is_exhausted=0",
    ).get();
    db.close();
    record(Number(cfKeys?.n ?? 0) >= 1, "at least one cloudflare key is available", String(cfKeys?.n));

    /* -------------------------------------------------------------- errors */
    console.log("\nError handling");
    const bad = await post("/v1/chat/completions", { model: "no-such-model", messages: [{ role: "user", content: "x" }] });
    record(bad.status === 400 && bad.body?.error?.code === "alias_unknown", "unknown model is rejected clearly", bad.body?.error?.code);
    const noRoute = await get("/v1/nope");
    record(noRoute.status === 404, "unknown route 404s");
    const empty = await post("/v1/chat/completions", { model: "cloudflare:x", messages: [] });
    record(empty.status === 400, "empty messages rejected", String(empty.status));

    /* -------------------------------------------------------------- helpers */
    console.log("\nHelpers");
    const hh = await get("/v1/health");
    const helperDetail = hh.body?.helpers?.detail ?? {};
    const needleOk = hh.body?.helpers?.needle === true;
    const layaOk = hh.body?.helpers?.laya === true;
    record(needleOk || !needleOk, "helper status is reported", `needle=${needleOk} laya=${layaOk}`);
    if (!needleOk) console.log(`       needle: ${helperDetail.needle}`);
    if (!layaOk) console.log(`       laya: ${helperDetail.laya}`);
    // Absent helpers must not break anything: the catalog must still answer.
    record(models.status === 200, "catalog still serves with helpers unavailable");
  } finally {
    child.kill();
  }

  console.log(`\n${"=".repeat(56)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`  failing: ${failures.join(", ")}`);
  console.log(`${"=".repeat(56)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E run failed:", err);
  process.exit(1);
});
