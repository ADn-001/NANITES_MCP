/**
 * Provider-namespaced model ids.
 *
 * A model id alone is not an identity: the same id can be served by more than
 * one provider, and two OpenAI-compatible gateways are separate accounts with
 * separate keys and separate billing. The namespace makes the provider part of
 * the value, so nothing downstream has to remember to pair the two.
 *
 * The round-trip matters most — a namespaced id must reduce back to exactly the
 * id the provider's API knows, or every call fails at the gateway. The `:` in a
 * provider's own id (`qwen/qwen3.8-27b:free`) is the case that would break a
 * naive split, so it is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  namespaceModelId,
  parseModelId,
  wireModelId,
  providerOfModelId,
  isNamespaced,
  idBelongsTo,
} from "../../src/storage/providerModelId.js";

describe("provider-namespaced model ids", () => {
  it("round-trips a plain cloud model id", () => {
    const stored = namespaceModelId("cloudflare", "@cf/meta/llama-3.2-3b-instruct");
    expect(stored).toBe("cloudflare:@cf/meta/llama-3.2-3b-instruct");
    expect(wireModelId(stored)).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(providerOfModelId(stored)).toBe("cloudflare");
  });

  it("round-trips an id that itself contains a colon", () => {
    // The real shape: OpenRouter free-tier ids carry a ":free" suffix, so a
    // split on the first separator has to leave the rest intact.
    const stored = namespaceModelId("openrouter", "qwen/qwen3.8-27b:free");
    expect(wireModelId(stored)).toBe("qwen/qwen3.8-27b:free");
    expect(providerOfModelId(stored)).toBe("openrouter");
  });

  it("round-trips a local model id", () => {
    const stored = namespaceModelId("local", "qwen3.5-0.8b");
    expect(stored).toBe("local:qwen3.5-0.8b");
    expect(wireModelId(stored)).toBe("qwen3.5-0.8b");
    expect(providerOfModelId(stored)).toBe("local");
  });

  it("carries the endpoint name for a generic gateway", () => {
    const stored = namespaceModelId("generic", "deepseek-v4-flash-0731", "codecraftapi");
    expect(stored).toBe("generic:codecraftapi:deepseek-v4-flash-0731");
    const parsed = parseModelId(stored);
    expect(parsed.provider).toBe("generic");
    expect(parsed.endpoint).toBe("codecraftapi");
    expect(parsed.model_id).toBe("deepseek-v4-flash-0731");
    expect(wireModelId(stored)).toBe("deepseek-v4-flash-0731");
  });

  it("keeps two gateways' copies of one model id distinct", () => {
    const a = namespaceModelId("generic", "deepseek-v4-flash-0731", "codecraftapi");
    const b = namespaceModelId("generic", "deepseek-v4-flash-0731", "othergw");
    expect(a).not.toBe(b);
    // ...while both still resolve to the same id on the wire, because each
    // gateway knows it under that name.
    expect(wireModelId(a)).toBe(wireModelId(b));
  });

  it("treats a legacy un-namespaced id as having no provider", () => {
    const parsed = parseModelId("@cf/meta/llama-3.2-3b-instruct");
    expect(parsed.namespaced).toBe(false);
    expect(parsed.provider).toBeNull();
    expect(isNamespaced("@cf/meta/llama-3.2-3b-instruct")).toBe(false);
    // It still reduces to itself, so a legacy row keeps working.
    expect(wireModelId("@cf/meta/llama-3.2-3b-instruct")).toBe("@cf/meta/llama-3.2-3b-instruct");
  });

  it("does not mistake a provider-like prefix on a legacy id for a namespace", () => {
    // Nothing in the wild starts a model id with "local:", but the parser must
    // not invent a provider for an id it does not own.
    const parsed = parseModelId("some/local:thing");
    expect(parsed.namespaced).toBe(false);
    expect(parsed.provider).toBeNull();
  });

  it("handles a generic id with no endpoint, and a malformed one", () => {
    expect(parseModelId("generic:model-only").endpoint).toBeNull();
    expect(parseModelId("generic:model-only").model_id).toBe("model-only");
    // An empty string must not throw or come back as namespaced.
    expect(wireModelId("")).toBe("");
  });

  it("answers which provider a stored id belongs to", () => {
    const stored = namespaceModelId("cloudflare", "@cf/x/y");
    expect(idBelongsTo(stored, "cloudflare")).toBe(true);
    expect(idBelongsTo(stored, "openrouter")).toBe(false);
    // A legacy id belongs to no provider, so it never claims one.
    expect(idBelongsTo("@cf/x/y", "cloudflare")).toBe(false);
  });

  it("scopes a generic id to its endpoint", () => {
    const stored = namespaceModelId("generic", "m", "codecraftapi");
    expect(idBelongsTo(stored, "generic", "codecraftapi")).toBe(true);
    expect(idBelongsTo(stored, "generic", "othergw")).toBe(false);
    // With no endpoint named, the provider is enough.
    expect(idBelongsTo(stored, "generic")).toBe(true);
  });
});
