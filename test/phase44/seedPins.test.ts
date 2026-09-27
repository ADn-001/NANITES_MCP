/**
 * Phase 44 gate — seed + pin tools + slash + claims filing.
 * Covers:
 * 1. Store seam: `registerManifestModel` writes manifest capabilities (vision
 *    -> image modality) idempotently and keeps nickname across re-seed.
 * 2. `seed_provider_models`: full seed registers 14, role-tags 14 registry
 *    placeholders (provider cloudflare, scores empty), writes the 7 default
 *    pins; idempotent re-seed (no dupes, pins preserved); a tested registry
 *    entry is never clobbered; a custom pin is preserved.
 * 3. Refusals before any write: unknown manifest id, non-cloudflare provider.
 * 4. Pin tool surface over tools/call: strict provider enum (bad provider ->
 *    structured error), list/delete round-trip, delete-nonexistent false.
 * 5. Slash/claims filing: command-sheet manifest guard passes and the canonical
 *    SKILL copy (artifact synced) reflects the vision/pin/seed rules.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import { checkNanitesSurface } from "../../src/server/commandsManifest.js";
import { RolePinStore } from "../../src/storage/rolePinStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import {
  CLOUDFLARE_AGENT_MANIFEST,
  CLOUDFLARE_DEFAULT_PINS,
} from "../../src/seed/cloudflareAgentManifest.js";

const GEM = "@cf/google/gemma-4-26b-a4b-it";
const VLM = "@cf/meta/llama-3.2-11b-vision-instruct";
const GPT = "@cf/openai/gpt-oss-120b";

let h: ToolHarness;
afterAll(async () => {
  await h?.close();
});

describe("Phase 44 — provider model store manifest seam", () => {
  beforeAll(async () => {
    h = await createHarness();
  });

  it("registerManifestModel writes vision->image modality + FC caps and is idempotent", () => {
    const store = new ProviderModelStore(h.deps.db);
    store.registerManifestModel("t", "cloudflare", {
      model_id: GEM,
      context_length: 256000,
      vision: true,
      function_calling: true,
    });
    let m = store.getModel("t", "cloudflare", GEM)!;
    expect(m.capabilities.vision).toBe(true);
    expect(m.capabilities.function_calling).toBe(true);
    expect(m.supported_modalities).toContain("image");
    expect(m.supported_modalities).toContain("text");
    expect(m.is_registered).toBe(true);

    // Nickname survives a re-seed; caps refresh.
    store.setNickname("t", "cloudflare", GEM, "my-gemma");
    store.registerManifestModel("t", "cloudflare", {
      model_id: GEM,
      context_length: 256000,
      vision: true,
      function_calling: false,
    });
    m = store.getModel("t", "cloudflare", GEM)!;
    expect(m.nickname).toBe("my-gemma");
    expect(m.capabilities.function_calling).toBe(false);
  });
});

describe("Phase 44 — seed_provider_models tool", () => {
  it("full seed registers the manifest, role-tags placeholders, writes default pins", async () => {
    const res = await h.callTool("seed_provider_models", {});
    expect(res.ok).toBe(true);
    const data = res.data as {
      profile: string; provider: string; registered_count: number; role_tagged: string[];
      default_pins_written: Array<{ role: string; model_id: string }>;
    };
    expect(data.provider).toBe("cloudflare");
    expect(data.registered_count).toBe(CLOUDFLARE_AGENT_MANIFEST.length);
    expect(data.role_tagged).toHaveLength(CLOUDFLARE_AGENT_MANIFEST.length);

    // Catalog: every manifest model registered with manifest vision caps.
    const store = new ProviderModelStore(h.deps.db);
    const catalog = store.listModels("t", "cloudflare", true).map((m) => m.model_id);
    for (const seed of CLOUDFLARE_AGENT_MANIFEST) {
      expect(catalog).toContain(seed.model_id);
      expect(store.getModel("t", "cloudflare", seed.model_id)!.capabilities.vision).toBe(seed.vision);
    }

    // Registry role-tags: provider cloudflare, empty scores, untested, roles incl vision.
    const reg = h.deps.registry;
    expect(reg.list("t")).toHaveLength(CLOUDFLARE_AGENT_MANIFEST.length);
    expect(reg.listLocal("t")).toHaveLength(0); // never visible to local selection
    for (const seed of CLOUDFLARE_AGENT_MANIFEST) {
      const e = reg.get("t", seed.model_id)!;
      expect(e.provider).toBe("cloudflare");
      expect(e.last_tested).toBeNull();
      expect(Object.values(e.scores)).toHaveLength(0);
      for (const role of seed.roles) expect(e.roles).toContain(role);
    }
    const gem = reg.get("t", GEM)!;
    expect(gem.roles).toContain("vision");
    expect(reg.get("t", VLM)!.roles).toEqual(["vision"]);

    // Default pins written for the six seeded roles + vision.
    const pins = new RolePinStore(h.deps.db).list("t");
    expect(pins.map((p) => `${p.role}:${p.provider}:${p.model_id}`).sort()).toEqual(
      CLOUDFLARE_DEFAULT_PINS.map((p) => `${p.role}:cloudflare:${p.model_id}`).sort(),
    );
  });

  it("re-seed is idempotent: no new registrations, no dupes, pins preserved", async () => {
    const res = await h.callTool("seed_provider_models", {});
    const data = res.data as {
      already_registered_count: number; role_tagged: string[]; default_pins_preserved: string[];
    };
    expect(data.already_registered_count).toBe(CLOUDFLARE_AGENT_MANIFEST.length);
    expect(data.role_tagged).toHaveLength(0); // placeholders already tagged, no rewrite needed? — still tagged but tested_kept...
    const pins = new RolePinStore(h.deps.db).list("t");
    expect(pins).toHaveLength(CLOUDFLARE_DEFAULT_PINS.length);
    expect(new Set(pins.map((p) => p.role)).size).toBe(pins.length);
    const catalog = new ProviderModelStore(h.deps.db).listModels("t", "cloudflare", true);
    expect(catalog).toHaveLength(CLOUDFLARE_AGENT_MANIFEST.length);
  });

  it("a tested registry entry is never clobbered by a re-seed role-tag", async () => {
    // Simulate prior testing evidence on gpt-oss.
    h.deps.registry.upsert("t", {
      model_id: GPT,
      provider: "cloudflare",
      roles: ["code_writer"],
      scores: { code_writer: 80 },
      best_params: { temperature: 0.2 },
      last_tested: "2026-09-10T00:00:00.000Z",
      performance_score: 66,
    });
    const res = await h.callTool("seed_provider_models", { model_ids: [GPT] });
    const data = res.data as { role_tagged: string[]; role_tags_tested_kept: string[] };
    expect(data.role_tags_tested_kept).toEqual([GPT]);
    expect(data.role_tagged).toEqual([]);
    const entry = h.deps.registry.get("t", GPT)!;
    expect(entry.scores.code_writer).toBe(80); // real evidence survived
    expect(entry.last_tested).not.toBeNull();
  });

  it("a custom pin is preserved over the default on a full re-seed", async () => {
    new RolePinStore(h.deps.db).set("t", {
      role: "reviewer",
      provider: "openrouter",
      model_id: "openai/gpt-5",
    });
    const res = await h.callTool("seed_provider_models", {});
    const data = res.data as { default_pins_written: unknown[]; default_pins_preserved: string[] };
    expect(data.default_pins_preserved).toContain("reviewer");
    // Every default pin already exists (earlier seeds), so a re-seed writes none.
    expect(data.default_pins_written).toHaveLength(0);
    const reviewer = new RolePinStore(h.deps.db).get("t", "reviewer")!;
    expect(reviewer).toMatchObject({ provider: "openrouter", model_id: "openai/gpt-5" });
  });

  it("unknown manifest id is refused before any write", async () => {
    const before = new ProviderModelStore(h.deps.db).listModels("t", "cloudflare", true).length;
    const res = await h.callTool("seed_provider_models", { model_ids: ["@cf/does-not-exist"] });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unknown_manifest_model");
    expect(res.error?.retryable).toBe(false);
    const after = new ProviderModelStore(h.deps.db).listModels("t", "cloudflare", true).length;
    expect(after).toBe(before);
  });

  it("non-cloudflare provider has no seed manifest", async () => {
    const res = await h.callTool("seed_provider_models", { provider: "openrouter" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("no_seed_manifest_for_provider");
  });
});

describe("Phase 44 — role pin tool surface", () => {
  it("set_role_pin rejects a provider outside the pin enum at the schema layer", async () => {
    const raw = await h.callToolRaw("set_role_pin", {
      role: "code_writer",
      provider: "not-a-provider",
      model_id: "x",
    });
    expect(raw.isError).toBe(true);
    expect(raw.text).toMatch(/provider/i);
  });

  it("list/set/delete round-trip against the store", async () => {
    const set = await h.callTool("set_role_pin", {
      role: "doc_writer",
      provider: "cloudflare",
      model_id: "@cf/nvidia/nemotron-3-120b-a12b",
    });
    expect(set.ok).toBe(true);
    const list = await h.callTool("list_role_pins", {});
    expect(list.ok).toBe(true);
    const pins = (list.data as { pins: Array<{ role: string }> }).pins;
    expect(pins.some((p) => p.role === "doc_writer")).toBe(true);

    const del = await h.callTool("delete_role_pin", { role: "doc_writer" });
    expect((del.data as { removed: boolean }).removed).toBe(true);
    const gone = await h.callTool("delete_role_pin", { role: "doc_writer" });
    expect((gone.data as { removed: boolean }).removed).toBe(false);
  });
});

describe("Phase 44 — claims filing (sheets + SKILL)", () => {
  it("command-sheet manifest guard passes on the real repo", () => {
    expect(checkNanitesSurface()).toEqual([]);
  });

  it("the canonical skill carries the vision/pin/seed guidance and the artifact is synced", () => {
    // The .claude artifact is kept diff-identical by scripts/copy-skill.mjs
    // (asserted byte-for-byte in test/phase33). Here: the canonical copy
    // reflects the Phase 4 delegation rules.
    const skill = readPluginSkill();
    expect(skill).toMatch(/Preferred-model pins, cloud routing, and vision/);
    expect(skill).toMatch(/vision_capable/);
    expect(skill).toMatch(/Bulk seeding/);
    expect(skill).toMatch(/auto-routes/);
    expect(skill).toMatch(/llama-3\.2-11b-vision/);
  });
});

function readPluginSkill(): string {
  const path = require("node:path");
  const fs = require("node:fs");
  return fs.readFileSync(path.join(process.cwd(), "plugin", "nanites", "skills", "nanites", "SKILL.md"), "utf8");
}
