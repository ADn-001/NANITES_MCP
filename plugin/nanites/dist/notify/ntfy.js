export function buildNtfyRequest(ntfy, message, tags) {
    const base = ntfy.server_url.replace(/\/+$/, "");
    const headers = { "Content-Type": "text/plain" };
    if (tags && tags.length > 0)
        headers["Tags"] = tags.join(",");
    if (ntfy.access_token)
        headers["Authorization"] = `Bearer ${ntfy.access_token}`;
    return { url: `${base}/${encodeURIComponent(ntfy.topic ?? "")}`, headers, body: message };
}
const PUSH_TIMEOUT_MS = 5_000;
export async function sendNtfy(ntfy, message, tags) {
    if (!ntfy.topic)
        return { sent: false, reason: "no_topic" };
    let request;
    try {
        request = buildNtfyRequest(ntfy, message, tags);
    }
    catch (err) {
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
        if (res.ok)
            return { sent: true, reason: null };
        console.warn(`nanites: ntfy push rejected: HTTP ${res.status}`);
        return { sent: false, reason: `http_${res.status}` };
    }
    catch (err) {
        console.warn(`nanites: ntfy push failed: ${err instanceof Error ? err.message : String(err)}`);
        return { sent: false, reason: "push_failed" };
    }
}
