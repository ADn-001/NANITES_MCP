import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCloudChatRequest, planCloudInference } from "../src/providers/cloudPlanner.js";
import { serializeChatRequest } from "../src/providers/client.js";
import type { ChatMessage } from "../src/providers/types.js";

type Settings = { accountId: string; token: string; gatewayId: string; gatewayToken?: string };
type Transport = (url: string, init: RequestInit) => Promise<Response>;

export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const accountId = env.CF_ACCOUNT_ID ?? "";
  const token = env.CF_API_TOKEN ?? "";
  const gatewayId = env.CF_GATEWAY_ID ?? "";
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Set CF_ACCOUNT_ID to the 32-character account ID.");
  if (!token.trim() || /[\r\n]/.test(token)) throw new Error("Set CF_API_TOKEN securely in the environment.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(gatewayId)) throw new Error("Set CF_GATEWAY_ID to the diagnostic gateway slug.");
  const gatewayToken = env.CF_AIG_AUTH_TOKEN;
  if (gatewayToken !== undefined && (!gatewayToken.trim() || /[\r\n]/.test(gatewayToken))) throw new Error("CF_AIG_AUTH_TOKEN must be non-empty without line breaks.");
  return { accountId, token, gatewayId, gatewayToken };
}

export function buildProbeBody(): Record<string, unknown> {
  const messages: ChatMessage[] = [{ role: "user", content: "Read fixture-1.txt through fixture-8.txt and report the sum of their values. These are synthetic fixtures. Output only the sum." }];
  for (let i = 1; i <= 8; i++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `probe_${i}`, name: "read_file", arguments: { path: `fixture-${i}.txt` } }] });
    messages.push({ role: "tool", name: "read_file", tool_call_id: `probe_${i}`, content: `value=${i}` });
  }
  return serializeChatRequest(buildCloudChatRequest(
    planCloudInference("medium", "reviewer"), "cloudflare", "@cf/openai/gpt-oss-120b", messages,
    "After you have read all necessary files, produce your final report. Do not call tools again once you have enough information.",
  ));
}

/**
 * Reproduction attempt for the empty-answer defect.
 * The short synthetic probe answered "36" cleanly; the failing production shape
 * is a LONGERTRANSCRIPT the model is "mid-read" when tools are withdrawn. Build
 * ~40 KB of synthetic tool results (matching the documented failing request
 * size), leave the transcript ending on `role:"tool"`, omit `tools`, and run at
 * the failing `medium` effort. Returns a body for ONE attempt; -repro fires it
 * N times.
 */
export function buildReproBody(): Record<string, unknown> {
  const pairs = 12;
  const lines = Array.from({ length: 60 }, (_, i) => `export const synthetic_var_${i} = "line ${i} of a synthetic fixture not drawn from any repository";`);
  const syntheticFile = lines.join("\n");
  const messages: ChatMessage[] = [
    { role: "user", content: "Read every fixture file and report the sum of the marker values at the last line of each. These are synthetic fixtures only. Output exactly the total." },
  ];
  for (let i = 1; i <= pairs; i++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `repro_${i}`, name: "read_file", arguments: { path: `fixture-${i}.txt` } }] });
    messages.push({ role: "tool", name: "read_file", tool_call_id: `repro_${i}`, content: `${syntheticFile}\nMARKER_VALUE: ${i}` });
  }
  return serializeChatRequest(buildCloudChatRequest(
    planCloudInference("medium", "reviewer"), "cloudflare", "@cf/openai/gpt-oss-120b", messages,
    "After you have read all necessary files, produce your final report. Do not call tools again once you have enough information.",
  ));
}

export async function captureAttempt(settings: Settings, body: Record<string, unknown>, route: "direct" | "gateway", transport: Transport = fetch) {
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" };
  if (route === "gateway") {
    headers["cf-aig-gateway-id"] = settings.gatewayId;
    headers["cf-aig-skip-cache"] = "true";
    headers["cf-aig-collect-log"] = "true";
    headers["cf-aig-collect-log-payload"] = "true";
    if (settings.gatewayToken) headers["cf-aig-authorization"] = `Bearer ${settings.gatewayToken}`;
  }
  const started = Date.now();
  let redacted = false;
  const redact = (text: string) => {
    for (const secret of [settings.token, settings.gatewayToken, settings.accountId].filter((s): s is string => Boolean(s)).sort((a, b) => b.length - a.length)) {
      if (text.includes(secret)) { redacted = true; text = text.split(secret).join("[REDACTED]"); }
    }
    return text;
  };
  try {
    const response = await transport(`https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/ai/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(240_000),
    });
    const capturedHeaders: Record<string, string> = {};
    for (const name of ["cf-ray", "cf-aig-log-id", "cf-aig-event-id", "cf-aig-cache-status", "cf-cache-status", "x-request-id", "content-type", "retry-after"]) {
      const value = response.headers.get(name);
      if (value !== null) capturedHeaders[name] = redact(value);
    }
    const rawBody = redact(await response.text());
    return { route, started_at: new Date(started).toISOString(), duration_ms: Date.now() - started, status: response.status as number | null, headers: capturedHeaders, raw_body: rawBody, redacted, transport_error: false };
  } catch {
    return { route, started_at: new Date(started).toISOString(), duration_ms: Date.now() - started, status: null, headers: {}, raw_body: "", redacted, transport_error: true };
  }
}

async function main() {
  if (!process.argv.includes("--live")) {
    console.log("Dry run only. Use --live with CF_ACCOUNT_ID, CF_API_TOKEN, CF_GATEWAY_ID; optional CF_AIG_AUTH_TOKEN. --repro [N] fires N (default 6) large forced-answer reproduction attempts. No tools execute. No automatic retries. Captures stay under NANITES_HOME/probes.");
    console.log(JSON.stringify(buildProbeBody(), null, 2));
    return;
  }
  const settings = readSettings(process.env);
  const reproArg = process.argv.indexOf("--repro");
  if (reproArg >= 0) {
    const n = Math.min(20, Number(process.argv[reproArg + 1] ?? 6) || 6);
    const parent = join(process.env.NANITES_HOME ?? join(homedir(), ".nanites"), "probes");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(parent, "cf-gateway-repro-"));
    const body = buildReproBody();
    writeFileSync(join(directory, "request.json"), JSON.stringify(body, null, 2), { flag: "wx", mode: 0o600 });
    let empty = 0;
    for (let i = 1; i <= n; i++) {
      const result = await captureAttempt(settings, body, "gateway");
      writeFileSync(join(directory, `attempt-${i}.json`), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
      let isEmpty = false;
      try {
        const choice = JSON.parse(result.raw_body)?.choices?.[0];
        isEmpty = result.status === 200 && !(choice?.message?.content ?? "") && !(choice?.message?.tool_calls?.length);
      } catch { /* non-JSON counts as failure, not empty */ }
      if (isEmpty) empty++;
      const finish = (() => { try { return JSON.parse(result.raw_body)?.choices?.[0]?.finish_reason; } catch { return null; } })();
      console.log(`attempt ${i}: http=${result.status ?? "transport_error"} finish=${finish} empty=${isEmpty}`);
      if (result.status === null || result.status < 200 || result.status >= 300) process.exitCode = 1;
    }
    console.log(`empty replies: ${empty}/${n}`);
    console.log(directory);
    return;
  }
  const parent = join(process.env.NANITES_HOME ?? join(homedir(), ".nanites"), "probes");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, "cf-gateway-"));
  const body = buildProbeBody();
  writeFileSync(join(directory, "request.json"), JSON.stringify(body, null, 2), { flag: "wx", mode: 0o600 });
  for (const route of ["direct", "gateway"] as const) {
    const result = await captureAttempt(settings, body, route);
    writeFileSync(join(directory, `${route}.json`), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`${route}: http=${result.status ?? "transport_error"} response_chars=${result.raw_body.length} redacted=${result.redacted}`);
    if (result.status === null || result.status < 200 || result.status >= 300) process.exitCode = 1;
    if (result.status === null || [401, 403, 429].includes(result.status)) break;
  }
  console.log("Private capture saved. No production settings or registry state changed.");
  console.log(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Probe failed.");
    process.exitCode = 1;
  });
}
