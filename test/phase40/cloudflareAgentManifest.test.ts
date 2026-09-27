/**
 * Phase 40 gate — seed manifest internal consistency.
 *
 * Validates `src/seed/cloudflareAgentManifest.ts` against a catalog fixture snapshot:
 * every id resolves to a real catalog entry, capability flags agree with the catalog,
 * vision-capable models carry the vision role, default pins are consistent, and the
 * vision role has ≥1 vision-capable pool member. No network.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_AGENT_MANIFEST,
  CLOUDFLARE_DEFAULT_PINS,
  VISION_CAPABLE_MODELS,
} from "../../src/seed/cloudflareAgentManifest.js";
import { catalogHas, catalogVisionFlags } from "./catalogFixture.js";

describe("manifest resolves against the catalog", () => {
  it("is non-empty with valid runnable ids", () => {
    expect(CLOUDFLARE_AGENT_MANIFEST.length).toBeGreaterThanOrEqual(13);
    const ids = CLOUDFLARE_AGENT_MANIFEST.map((m) => m.model_id);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id.startsWith("@cf/")).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it("every manifest id exists in the catalog", () => {
    for (const m of CLOUDFLARE_AGENT_MANIFEST) {
      expect(catalogHas(m.model_id), `id not in catalog: ${m.model_id}`).toBe(true);
    }
  });

  it("vision flags agree with the catalog (never claims vision on a non-vision entry)", () => {
    const flags = catalogVisionFlags();
    for (const m of CLOUDFLARE_AGENT_MANIFEST) {
      const catalogVision = flags.get(m.model_id)!;
      expect(m.vision).toBe(catalogVision);
    }
    expect(VISION_CAPABLE_MODELS).toHaveLength(
      CLOUDFLARE_AGENT_MANIFEST.filter((m) => m.vision).length,
    );
  });

  it("every vision-capable manifest model carries the vision role, and no text-only model does", () => {
    for (const m of CLOUDFLARE_AGENT_MANIFEST) {
      const taggedVision = m.roles.includes("vision");
      if (m.vision) {
        expect(taggedVision, `vision model missing vision role: ${m.model_id}`).toBe(true);
      } else {
        expect(taggedVision, `text-only model claims vision role: ${m.model_id}`).toBe(false);
      }
    }
  });

  it("role spread is non-empty and roles are sane for every entry", () => {
    for (const m of CLOUDFLARE_AGENT_MANIFEST) {
      expect(m.roles.length).toBeGreaterThan(0);
      for (const r of m.roles) {
        expect(typeof r).toBe("string");
        expect(r.trim()).not.toBe("");
      }
    }
  });

  it("context_length is a positive number where recorded", () => {
    for (const m of CLOUDFLARE_AGENT_MANIFEST) {
      expect(m.context_length).toBeGreaterThan(0);
    }
  });
});

describe("default pins are consistent", () => {
  it("every pinned role appears exactly once", () => {
    const roles = CLOUDFLARE_DEFAULT_PINS.map((p) => p.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("every pin target is a manifest member", () => {
    const manifestIds = new Set(CLOUDFLARE_AGENT_MANIFEST.map((m) => m.model_id));
    for (const p of CLOUDFLARE_DEFAULT_PINS) {
      expect(manifestIds.has(p.model_id), `pin target not in manifest: ${p.model_id}`).toBe(true);
    }
  });

  it("every pin target is registered in the catalog", () => {
    for (const p of CLOUDFLARE_DEFAULT_PINS) {
      expect(catalogHas(p.model_id)).toBe(true);
    }
  });

  it("the vision pin targets a vision-capable manifest model", () => {
    const visionPin = CLOUDFLARE_DEFAULT_PINS.find((p) => p.role === "vision");
    expect(visionPin).toBeDefined();
    const target = CLOUDFLARE_AGENT_MANIFEST.find((m) => m.model_id === visionPin!.model_id);
    expect(target?.vision).toBe(true);
  });
});

describe("vision role coverage", () => {
  it("has at least one vision-capable model tagged vision", () => {
    const visionModels = CLOUDFLARE_AGENT_MANIFEST.filter((m) => m.roles.includes("vision"));
    expect(visionModels.length).toBeGreaterThanOrEqual(1);
    expect(visionModels.every((m) => m.vision)).toBe(true);
    expect(visionModels.length).toBe(VISION_CAPABLE_MODELS.length);
  });

  it("vision pool spans more than the pinned model (fallback depth exists)", () => {
    const visionPin = CLOUDFLARE_DEFAULT_PINS.find((p) => p.role === "vision")!.model_id;
    expect(VISION_CAPABLE_MODELS.length).toBeGreaterThanOrEqual(2);
    expect(VISION_CAPABLE_MODELS.some((id) => id !== visionPin)).toBe(true);
  });
});
