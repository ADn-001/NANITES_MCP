/**
 * Test-only re-export of the error classifier.
 *
 * `classifyRunError` is private to cloudflareRun.ts because nothing else needs
 * it — but the E2E proved its 429 handling was wrong in a way no other test
 * could see, so the mapping is worth pinning directly.
 */
export { classifyRunError as classifyRunErrorForTest } from "../../src/router/outbound/cloudflareRun.js";
