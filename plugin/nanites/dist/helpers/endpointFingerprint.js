/**
 * Endpoint fingerprint for cross-profile result sharing.
 *
 * Two profiles that point at the SAME LM Studio instance test the same models,
 * so re-running the whole regimen in each profile is redundant. Sharing is
 * opt-in and gated on matching fingerprints: normalized URL + whether an auth
 * token is attached. The fingerprint never contains the token itself nor any
 * machine-specific string (CLAUDE.md §6) — it is a short opaque hash.
 */
import { createHash } from "node:crypto";
const PREFIX = "fp";
/** Normalized URL: lowercase origin-ish form, trailing slashes stripped. */
export function normalizeEndpointUrl(url) {
    return url.trim().toLowerCase().replace(/\/+$/, "");
}
/** Short opaque fingerprint. `authPresent` = effective token attached (per
 * profile token OR the NANITES_LMS_API_TOKEN env fill), never its value. */
export function endpointFingerprint(url, authPresent) {
    const normalized = normalizeEndpointUrl(url);
    const tag = authPresent ? "auth" : "noauth";
    const hash = createHash("sha256").update(`${normalized}|${tag}`).digest("hex").slice(0, 16);
    return `${PREFIX}_${hash}`;
}
/** Both profiles present the same access surface: same URL + same auth-ness. */
export function sameEndpoint(a, b) {
    return endpointFingerprint(a.url, a.authPresent) === endpointFingerprint(b.url, b.authPresent);
}
