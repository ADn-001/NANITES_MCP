/**
 * Phase 43 gate — cloud regimen + merged leaderboard.
 * The cloud regimen routes per-unit chats through an injected `cloudChat` seam
 * (no network), so this runs on scratch homes with real stores.
 * Covers:
 * 1. Migration v18: fresh DB lands on 18 with test_results.provider; a legacy
 *    v17 DB gains the column idempotently.
 * 2. Cloud deterministic regimen: row shapes identical to local, and finalize
 *    writes a provider-tagged registry entry (provider = cloudflare), with a
 *    local registry untouched.
 * 3. Cloud judged flow: baseline pending + variant staged rows carry the
 *    provider; submit-approve both candidates finalizes a provider-tagged
 *    entry through the unchanged (provider-less) submit path.
 * 4. Merged leaderboard: view=all mixes local + cloud registry rows sorted by
 *    real per-role scores; any role filters; local view stays local-only;
 *    registered-but-untested cloud rows show a null score.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { applyMigrations, MIGRATIONS } from "../../src/storage/migrations.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { runTestRegimen } from "../../src/workflows/runTestRegimen.js";
import { submitTestJudgment } from "../../src/workflows/submitTestJudgment.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import type { TestUnit } from "../../src/testunits/schema.js";

const homes: ToolDeps[] = [];

function harness(profileName = "t"): ToolDeps {
  const d = buildDeps(scratchHome());
  homes.push(d);
  d.profiles.createProfile({ name: profileName });
  return d;
}

function detUnit(): TestUnit {
  return {
    id: "u-det-json",
    name: "json output",
    task_group: "format",
    difficulty: "easy",
    prompts: [{ id: "p1", text: 'Return valid JSON {"ok":true}', expected: null, notes: null }],
    measures: ["format_compliance"],
    applicable_roles: ["code_writer"],
    recommended_config: {
      context_length: 4096,
      kv_cache_quant: "Q8",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.1,
      max_output_tokens: 256,
    },
    scoring: { method: "deterministic_rule", rule: { type: "json_valid", params: {} } },
    source: "custom_authored",
    version: 1,
  };
}

function judgedUnit(): TestUnit {
  return {
    id: "u-judged",
    name: "human review",
    task_group: "quality",
    difficulty: "medium",
    prompts: [{ id: "p1", text: "Write a one-line summary", expected: null, notes: null }],
    measures: ["quality"],
    applicable_roles: ["summarizer"],
    recommended_config: {
      context_length: 4096,
      kv_cache_quant: "Q8",
      temperature: 0.3,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      max_output_tokens: 128,
    },
    scoring: {
      method: "orchestrator_judged",
      rubric: "Concise, faithful, no hallucinated detail.",
    },
    source: "custom_authored",
    version: 1,
  };
}

afterAll(() => {
  for (const d of homes.splice(0)) {
    d.close();
    cleanup(d.home);
  }
});

describe("migration v18", () => {
  it("fresh DB applies to user_version 18 with test_results.provider", () => {
    const d = harness();
    const row = d.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(MIGRATIONS.length);
    const cols = d.db.prepare("PRAGMA table_info(test_results)").all() as Array<{ name: string; notnull: number }>;
    const provider = cols.find((c) => c.name === "provider");
    expect(provider).toBeDefined();
    expect(provider!.notnull).toBe(0);
  });

  it("legacy v17 DB upgrades: test_results gains provider idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-mig18-"));
    const dbPath = path.join(dir, "nanites.db");
    const db = new DatabaseSync(dbPath);
    try {
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
      db.exec("PRAGMA user_version = 17");
      applyMigrations(db);
      const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(row.user_version).toBe(MIGRATIONS.length);
      const cols = db.prepare("PRAGMA table_info(test_results)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "provider")).toBe(true);
      // Idempotent re-apply is a no-op (still 18, column still there).
      applyMigrations(db);
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cloud deterministic regimen", () => {
  it("row shapes match local and finalize writes a provider-tagged entry; local untouched", async () => {
    const d = harness("p-det");
    d.testUnits.register("p-det", detUnit());
    const prompts: string[] = [];
    const chat = async (i: { prompt: string; provider: string; model_id: string }): Promise<{ text: string }> => {
      prompts.push(i.prompt);
      expect(i.provider).toBe("cloudflare");
      expect(i.model_id).toBe("@cf/openai/gpt-oss-120b");
      return { text: '{"ok":true}' };
    };

    const summary = await runTestRegimen(d, "p-det", "@cf/openai/gpt-oss-120b", {
      provider: "cloudflare",
      cloudChat: chat,
    });

    expect(summary.deterministic_scored).toBe(1);
    expect(summary.pending_unit_ids).toEqual([]);
    expect(summary.param_attempts).toBe(2); // baseline + variant both logged
    expect(summary.clamped_units).toEqual([]);
    expect(prompts).toHaveLength(2); // one chat per candidate

    const rows = d.testResults.list("p-det", "@cf/openai/gpt-oss-120b");
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      unit_id: "u-det-json",
      status: "approved",
      candidate: "baseline",
      score: 100,
      raw_output: null,
      provider: "cloudflare",
    });
    expect(typeof rows[0]!.test_run).toBe("number");

    // finalize wrote a provider-tagged registry entry.
    const entry = d.registry.get("p-det", "@cf/openai/gpt-oss-120b");
    expect(entry?.provider).toBe("cloudflare");
    expect(entry?.roles).toContain("code_writer");

    // No local rows were created; listLocal never sees the cloud model.
    expect(d.registry.listLocal("p-det").map((e) => e.model_id)).toEqual([]);
  });
});

describe("cloud judged flow", () => {
  it("pending/staged rows carry provider; submit finalizes provider-tagged entry via unchanged path", async () => {
    const d = harness("p-judged");
    d.testUnits.register("p-judged", judgedUnit());
    const chat = async (): Promise<{ text: string }> => ({ text: "A concise summary of the input." });

    const summary = await runTestRegimen(d, "p-judged", "@cf/google/gemma-4-26b-a4b-it", {
      provider: "cloudflare",
      cloudChat: chat,
    });

    expect(summary.deterministic_scored).toBe(0);
    expect(summary.pending_unit_ids).toEqual(["u-judged"]);
    const rows = d.testResults.list("p-judged", "@cf/google/gemma-4-26b-a4b-it");
    expect(rows).toHaveLength(2);
    const byCand = Object.fromEntries(rows.map((r) => [r.candidate, r]));
    expect(byCand.baseline!.status).toBe("pending");
    expect(byCand.variant!.status).toBe("staged");
    expect(rows.every((r) => r.provider === "cloudflare")).toBe(true);
    expect(rows.every((r) => r.raw_output?.length ?? 0 > 0)).toBe(true);

    // Registry not yet written while a unit is pending.
    expect(d.registry.get("p-judged", "@cf/google/gemma-4-26b-a4b-it")).toBeNull();

    // Serial judging: baseline, then the promoted variant. Provider-less submit
    // path must still finalize a cloudflare-tagged entry from the row stamp.
    submitTestJudgment(d, {
      profile: "p-judged",
      model_id: "@cf/google/gemma-4-26b-a4b-it",
      unit_id: "u-judged",
      score: 88,
      orchestrator_notes: "good",
      user_approved: true,
    });
    expect(d.registry.get("p-judged", "@cf/google/gemma-4-26b-a4b-it")).toBeNull(); // variant still pending

    submitTestJudgment(d, {
      profile: "p-judged",
      model_id: "@cf/google/gemma-4-26b-a4b-it",
      unit_id: "u-judged",
      score: 92,
      orchestrator_notes: "better",
      user_approved: true,
    });
    const entry = d.registry.get("p-judged", "@cf/google/gemma-4-26b-a4b-it");
    expect(entry?.provider).toBe("cloudflare");
    expect(entry?.scores.summarizer).toBe(92); // unit collapses to winner (variant 92 > baseline 88)
  });
});

describe("merged leaderboard", () => {
  it("view=all mixes local + cloud rows by real per-role score; any role filters; local stays local-only; untested cloud null-score", async () => {
    const d = harness("p-lb");
    d.profiles.switchProfile("p-lb");
    // Local registry entry.
    d.registry.upsert("p-lb", {
      model_id: "local/llama",
      roles: ["reviewer"],
      scores: { reviewer: 60 },
      score_minima: { reviewer: 40 },
      best_params: {},
      performance_score: 80,
    });
    // Cloud registry entry (finalized by a prior cloud regimen).
    d.registry.upsert("p-lb", {
      model_id: "@cf/glm-review",
      provider: "cloudflare",
      roles: ["reviewer"],
      scores: { reviewer: 95 },
      score_minima: { reviewer: 90 },
      best_params: {},
      performance_score: null as never,
    });
    // A vision role beyond the old 4-value enum on a local model.
    d.registry.upsert("p-lb", {
      model_id: "local/vlm",
      roles: ["vision"],
      scores: { vision: 70 },
      score_minima: { vision: 50 },
      best_params: {},
      performance_score: 60,
    });
    // Registered-but-untested cloud model (provider catalog only, no registry).
    new ProviderModelStore(d.db).registerModel("p-lb", "cloudflare", "@cf/untested-model");

    const ui: UiServer = await startUiServer(d, { port: 0 });
    const base = `http://127.0.0.1:${ui.port}`;
    try {
      const all = (await (await fetch(`${base}/api/leaderboard?role=all`)).json()) as {
        rows: Array<{ model: string; provider: string | null; score: number | null }>;
      };
      const allModels = all.rows.map((r) => `${r.model}:${r.provider ?? "local"}:${r.score}`);
      // Ordered by performance/score desc: local/llama (80) first, then
      // local/vlm (60), then cloud null-score cloudflare 50? — cloud entry has
      // null performance so scores null sink below; untested null-scores last.
      expect(all.rows[0]!.model).toBe("local/llama");
      expect(all.rows.find((r) => r.model === "@cf/glm-review")?.provider).toBe("cloudflare");
      // Untested registered cloud row present with null score.
      const untested = all.rows.find((r) => r.model === "@cf/untested-model");
      expect(untested?.score).toBeNull();
      expect(untested?.provider).toBe("cloudflare");
      expect(allModels).toHaveLength(4);

      // role=reviewer → real per-role score ordering: cloud 95 above local 60;
      // the vision model (no reviewer role) is excluded.
      const reviewers = (await (await fetch(`${base}/api/leaderboard?role=reviewer`)).json()) as {
        rows: Array<{ model: string; provider: string | null; score: number | null; score_minima: number | null }>;
      };
      expect(reviewers.rows.map((r) => r.model)).toEqual(["@cf/glm-review", "local/llama"]);
      expect(reviewers.rows[0]!.score).toBe(95);
      expect(reviewers.rows[0]!.score_minima).toBe(90);
      expect(reviewers.rows[1]!.provider).toBeNull();

      // role=vision works for the 11th built-in role.
      const vision = (await (await fetch(`${base}/api/leaderboard?role=vision`)).json()) as { rows: Array<{ model: string }> };
      expect(vision.rows.map((r) => r.model)).toEqual(["local/vlm"]);

      // view=local excludes cloud registry + untested cloud rows.
      const localView = (await (await fetch(`${base}/api/leaderboard?role=all&view=local`)).json()) as {
        rows: Array<{ model: string; provider: string | null }>;
      };
      expect(localView.rows.map((r) => r.model).sort()).toEqual(["local/llama", "local/vlm"]);
      expect(localView.rows.every((r) => r.provider === null)).toBe(true);

      // view=cloud returns the cloud registry row + untested row only.
      const cloudView = (await (await fetch(`${base}/api/leaderboard?role=all&view=cloud`)).json()) as {
        rows: Array<{ model: string; provider: string | null }>;
      };
      expect(cloudView.rows.map((r) => r.model).sort()).toEqual(["@cf/glm-review", "@cf/untested-model"]);
      expect(cloudView.rows.every((r) => r.provider === "cloudflare")).toBe(true);
    } finally {
      await ui.close();
    }
  });
});
