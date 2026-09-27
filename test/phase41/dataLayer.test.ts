/**
 * Phase 41 gate — data layer + role vocabulary.
 * Validates:
 * 1. Migration v16 -> v17 (legacy DB gains model_registry.provider + role_pins)
 *    and fresh-DB apply lands on user_version 17 with both present.
 * 2. RegistryStore round-trips provider (null = local; cloud kind persisted),
 *    and listLocal excludes cloud rows.
 * 3. RolePinStore CRUD + per-profile isolation + strict provider enum.
 * 4. Profile `vision_capable` persists through create/update/read (default true).
 * 5. `vision` is an 11th built-in role; test-unit validator accepts it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { applyMigrations, MIGRATIONS } from "../../src/storage/migrations.js";
import { RolePinStore } from "../../src/storage/rolePinStore.js";
import { BUILT_IN_ROLES } from "../../src/workflows/roleMatch.js";
import { validateTestUnit } from "../../src/testunits/validator.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: ToolDeps[] = [];

function harness(): ToolDeps {
  const deps = buildDeps(scratchHome());
  homes.push(deps);
  return deps;
}

afterAll(() => {
  for (const d of homes.splice(0)) {
    d.close();
    cleanup(d.home);
  }
});

describe("migration v17", () => {
  it("fresh DB applies to the current top version with provider column + role_pins", () => {
    const d = harness();
    const row = d.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(MIGRATIONS.length);

    const cols = d.db.prepare("PRAGMA table_info(model_registry)").all() as Array<{ name: string }>;
    const provider = cols.find((c) => c.name === "provider");
    expect(provider).toBeDefined();
    expect(provider!.notnull).toBe(0); // nullable

    const pinTable = d.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_pins'")
      .all();
    expect(pinTable).toHaveLength(1);
  });

  it("legacy v16 DB upgrades: provider column added idempotently + role_pins created", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-mig17-"));
    const dbPath = path.join(dir, "nanites.db");
    const db = new DatabaseSync(dbPath);
    try {
      // Simulate a pre-v17 DB: v1 model_registry shape, user_version pinned at 16.
      db.exec(`
        CREATE TABLE model_registry (
          profile_name TEXT NOT NULL,
          model_id     TEXT NOT NULL,
          roles        TEXT NOT NULL DEFAULT '[]',
          scores       TEXT NOT NULL DEFAULT '{}',
          best_params  TEXT NOT NULL DEFAULT '{}',
          last_tested  TEXT,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          PRIMARY KEY (profile_name, model_id)
        );
      `);
      db.exec("PRAGMA user_version = 16");
      // A real v16 DB already holds test_results (added at v11); the chain
      // v17 -> v18 appends model_registry.provider, role_pins, and then
      // test_results.provider, so the fixture needs the table present.
      db.exec(`
        CREATE TABLE test_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_name TEXT NOT NULL,
          model_id     TEXT NOT NULL,
          unit_id      TEXT NOT NULL,
          status       TEXT NOT NULL,
          candidate    TEXT NOT NULL DEFAULT 'baseline',
          test_run     INTEGER NOT NULL DEFAULT 0,
          score        INTEGER,
          raw_output   TEXT,
          orchestrator_notes TEXT,
          user_notes   TEXT,
          user_approved INTEGER,
          created_at   TEXT,
          updated_at   TEXT
        );
      `);

      applyMigrations(db);

      const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(row.user_version).toBe(MIGRATIONS.length);
      const cols = db.prepare("PRAGMA table_info(model_registry)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "provider")).toBe(true);
      const pinTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_pins'")
        .all();
      expect(pinTable).toHaveLength(1);
      // v18 appended test_results.provider; the legacy chain reaches it.
      const trCols = db.prepare("PRAGMA table_info(test_results)").all() as Array<{ name: string }>;
      expect(trCols.some((c) => c.name === "provider")).toBe(true);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry provider round-trip", () => {
  it("upsert/get/list preserves provider; default is null (local); listLocal excludes cloud", () => {
    const d = harness();
    const reg = d.registry;
    reg.upsert("p", {
      model_id: "local-model",
      roles: ["code_writer"],
      scores: { code_writer: 70 },
      best_params: {},
    });
    reg.upsert("p", {
      model_id: "@cf/openai/gpt-oss-120b",
      provider: "cloudflare",
      roles: ["code_writer"],
      scores: { code_writer: 80 },
      best_params: {},
    });

    expect(reg.get("p", "local-model")?.provider).toBeNull();
    expect(reg.get("p", "@cf/openai/gpt-oss-120b")?.provider).toBe("cloudflare");

    const all = reg.list("p").map((e) => e.model_id);
    expect(all).toEqual(expect.arrayContaining(["local-model", "@cf/openai/gpt-oss-120b"]));
    // Cloud entry keeps its scores/roles machinery identical to local.
    expect(reg.get("p", "@cf/openai/gpt-oss-120b")?.scores.code_writer).toBe(80);

    const localOnly = reg.listLocal("p").map((e) => e.model_id);
    expect(localOnly).toEqual(["local-model"]);
    expect(localOnly).not.toContain("@cf/openai/gpt-oss-120b");
  });

  it("local selection consumers read listLocal (btw/compaction/local sub-agent use it)", () => {
    const d = harness();
    const reg = d.registry;
    reg.upsert("p", { model_id: "local-model", roles: ["reviewer"], scores: { reviewer: 66 }, best_params: {} });
    reg.upsert("p", {
      model_id: "@cf/zai-org/glm-4.7-flash",
      provider: "cloudflare",
      roles: ["reviewer"],
      scores: { reviewer: 95 },
      best_params: {},
    });
    // A cloud row would win a plain list() pick (higher score) — listLocal must not see it.
    const entries = reg.listLocal("p");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.model_id).toBe("local-model");
  });
});

describe("role pin store", () => {
  it("set/get/list/remove per profile; profiles isolated", () => {
    const d = harness();
    const pins = new RolePinStore(d.db);
    pins.set("p1", { role: "code_writer", provider: "cloudflare", model_id: "@cf/openai/gpt-oss-120b" });
    pins.set("p1", { role: "reviewer", provider: "local", model_id: "local-llama" });
    pins.set("p2", { role: "code_writer", provider: "openrouter", model_id: "openai/gpt-5" });

    expect(pins.get("p1", "code_writer")).toMatchObject({
      role: "code_writer",
      provider: "cloudflare",
      model_id: "@cf/openai/gpt-oss-120b",
    });
    expect(pins.list("p1").map((p) => p.role).sort()).toEqual(["code_writer", "reviewer"]);
    // Isolation: p2's pin differs and p1 has no p2 leakage.
    expect(pins.get("p1", "code_writer")?.provider).toBe("cloudflare");
    expect(pins.get("p2", "code_writer")?.model_id).toBe("openai/gpt-5");
    expect(pins.list("p1").every((p) => p.role !== "vision")).toBe(true);

    // Upsert replaces same role.
    pins.set("p1", { role: "reviewer", provider: "generic", model_id: "local-llama" });
    expect(pins.get("p1", "reviewer")?.provider).toBe("generic");
    expect(pins.list("p1")).toHaveLength(2);

    expect(pins.remove("p1", "code_writer")).toBe(true);
    expect(pins.get("p1", "code_writer")).toBeNull();
    expect(pins.remove("p1", "code_writer")).toBe(false);
  });

  it("local provider accepted; invalid provider rejected with structured error", () => {
    const d = harness();
    const pins = new RolePinStore(d.db);
    expect(() => pins.set("p", { role: "vision", provider: "local", model_id: "local-vlm" })).not.toThrow();
    expect(() => pins.set("p", { role: "vision", provider: "not-a-provider", model_id: "x" })).toThrow(
      /must be one of: local/,
    );
  });
});

describe("profile vision_capable flag", () => {
  it("defaults true on create and persists through update", () => {
    const d = harness();
    const created = d.profiles.createProfile({ name: "visionp" });
    expect(created.vision_capable).toBe(true);

    const updated = d.profiles.updateProfile("visionp", { name: "visionp", vision_capable: false });
    expect(updated.vision_capable).toBe(false);

    // Persisted to disk — a fresh read sees it.
    const reread = d.profiles.getProfile("visionp");
    expect(reread?.vision_capable).toBe(false);
  });

  it("legacy profile file without the field reads as true", () => {
    const d = harness();
    d.profiles.createProfile({ name: "legacy" });
    const file = path.join(d.home, "profiles", "legacy.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    delete parsed.vision_capable;
    fs.writeFileSync(file, JSON.stringify(parsed));
    expect(d.profiles.getProfile("legacy")?.vision_capable).toBe(true);
  });
});

describe("vision role vocabulary", () => {
  it("vision is the 11th built-in role", () => {
    expect(BUILT_IN_ROLES).toContain("vision");
    expect(BUILT_IN_ROLES).toHaveLength(11);
  });

  it("test-unit validator accepts a vision role", () => {
    const verdict = validateTestUnit({
      id: "u-vision",
      name: "image description",
      task_group: "vision",
      difficulty: "medium",
      prompts: [{ id: "p1", text: "Describe this screenshot", expected: null, notes: null }],
      measures: ["quality", "format_compliance"],
      applicable_roles: ["vision"],
      recommended_config: {
        context_length: 8192,
        kv_cache_quant: "Q8",
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
        max_output_tokens: 512,
      },
      scoring: { method: "deterministic_rule", rule: { type: "label_in_set", params: { set: ["a", "b"] } } },
      source: "custom_authored",
      version: 1,
    });
    expect(verdict.ok).toBe(true);
  });
});
