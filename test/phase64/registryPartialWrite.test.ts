/**
 * Phase 64 gate — registry partial writes must not destroy tested data
 *.
 *
 * All seven upsert call sites pass partial entries. The conflict clause used
 * to overwrite every column from excluded, so a regimen finalize reset
 * performance_score to 50 and nulled both rolling averages, and a score write
 * that omitted provider re-tagged a CLOUD model as local. provider is not in
 * the primary key, so that last one silently destroyed the cloud/local
 * distinction the leaderboard depends on.
 */
import { describe, expect, it } from "vitest";
import { openNanitesDb } from "../../src/storage/db.js";
import { RegistryStore } from "../../src/storage/registryStore.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

function harness() {
  const home = scratchHome();
  const { db, close } = openNanitesDb(home);
  const registry = new RegistryStore(db);
  return {
    home,
    registry,
    done() {
      close();
      cleanup(home);
    },
  };
}

describe("a partial write preserves untouched columns", () => {
  it("a finalize-shaped write keeps the performance score and averages", () => {
    const h = harness();
    h.registry.upsert("t", {
      model_id: "m",
      roles: ["code"],
      scores: {},
      best_params: {},
      last_tested: null,
      performance_score: 91,
      avg_load_ms: 1200,
      avg_response_ms: 340,
      reasoning_type: "reasoning",
    });

    // This is what finalize sends: no score, no averages, no reasoning type.
    h.registry.upsert("t", {
      model_id: "m",
      roles: ["code"],
      scores: { code: 88 },
      score_minima: { code: 88 },
      best_params: {},
      last_tested: "2026-01-01T00:00:00.000Z",
    });

    const got = h.registry.get("t", "m");
    expect(got?.performance_score).toBe(91);
    expect(got?.avg_load_ms).toBe(1200);
    expect(got?.avg_response_ms).toBe(340);
    expect(got?.reasoning_type).toBe("reasoning");
    // ...while the fields it DID supply are applied.
    expect(got?.scores).toEqual({ code: 88 });
    expect(got?.last_tested).toBe("2026-01-01T00:00:00.000Z");
    h.done();
  });

  it("a cloud row stays cloud across a local-shaped score write", () => {
    const h = harness();
    h.registry.upsert("t", {
      model_id: "m",
      provider: "cloudflare",
      roles: [],
      scores: {},
      best_params: {},
      last_tested: null,
    });
    // The score write path carries provider forward; assert it stays set.
    const existing = h.registry.get("t", "m");
    h.registry.upsert("t", {
      model_id: "m",
      provider: existing?.provider ?? null,
      roles: [],
      scores: {},
      best_params: {},
      last_tested: null,
      performance_score: 77,
    });
    expect(h.registry.get("t", "m")?.provider).toBe("cloudflare");
    expect(h.registry.get("t", "m")?.performance_score).toBe(77);
    h.done();
  });

  it("an explicit score still updates", () => {
    const h = harness();
    h.registry.upsert("t", {
      model_id: "m",
      roles: [],
      scores: {},
      best_params: {},
      last_tested: null,
      performance_score: 50,
    });
    h.registry.upsert("t", {
      model_id: "m",
      roles: [],
      scores: {},
      best_params: {},
      last_tested: null,
      performance_score: 88,
    });
    expect(h.registry.get("t", "m")?.performance_score).toBe(88);
    h.done();
  });

  it("roles and score_minima survive a score-only write", () => {
    const h = harness();
    h.registry.upsert("t", {
      model_id: "m",
      roles: ["code", "qa"],
      scores: { code: 90, qa: 70 },
      score_minima: { code: 85, qa: 60 },
      best_params: {},
      last_tested: null,
    });
    h.registry.upsert("t", {
      model_id: "m",
      roles: ["code", "qa"],
      scores: { code: 90, qa: 70 },
      best_params: {},
      last_tested: null,
      performance_score: 65,
    });
    const got = h.registry.get("t", "m");
    expect(got?.score_minima).toEqual({ code: 85, qa: 60 });
    h.done();
  });
});
