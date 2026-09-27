/**
 * ntfy push helper. Fire-and-forget by contract: a failed push NEVER fails the
 * underlying operation — sendNtfy never throws, it returns {sent, reason} and
 * logs the failure server-side only. Default resolution per §1: a profile with
 * only `topic` set posts to https://ntfy.sh with no auth; an explicit
 * server_url/access_token overrides both.
 */
import type { NtfyConfig } from "../storage/profileDefaults.js";

export interface NtfyRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface NtfyResult {
  sent: boolean;
  reason: string | null;
}

export function buildNtfyRequest(ntfy: NtfyConfig, message: string, tags?: string[]): NtfyRequest {
  const base = ntfy.server_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (tags && tags.length > 0) headers["Tags"] = tags.join(",");
  if (ntfy.access_token) headers["Authorization"] = `Bearer ${ntfy.access_token}`;
  return { url: `${base}/${encodeURIComponent(ntfy.topic ?? "")}`, headers, body: message };
}

const PUSH_TIMEOUT_MS = 5_000;

export async function sendNtfy(ntfy: NtfyConfig, message: string, tags?: string[]): Promise<NtfyResult> {
  if (!ntfy.topic) return { sent: false, reason: "no_topic" };

  let request: NtfyRequest;
  try {
    request = buildNtfyRequest(ntfy, message, tags);
  } catch (err) {
    console.warn(`nanites: ntfy request build failed: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: "build_failed" };
  }

  try {
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (res.ok) return { sent: true, reason: null };
    console.warn(`nanites: ntfy push rejected: HTTP ${res.status}`);
    return { sent: false, reason: `http_${res.status}` };
  } catch (err) {
    console.warn(`nanites: ntfy push failed: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: "push_failed" };
  }
}
