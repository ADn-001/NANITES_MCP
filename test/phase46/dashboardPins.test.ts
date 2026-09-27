/**
 * Phase 46 gate — dashboard surface. Over the real UI server on
 * a scratch home:
 * 1. /api/pins CRUD: empty list, set (replace flag), re-set overwrite, delete,
 *    invalid-provider rejection, missing-field rejection.
 * 2. /api/roles: built-in role vocabulary (eleven, incl. vision) + custom roles
 *    from registered test units; per-role row counts from the merged model
 *    universe (registry roles + untested registered vision-capable models).
 * 3. Leaderboard ?role=vision merge: a registered-but-untested vision-capable
 *    cloud model (provider catalog only) shows under the vision tab with a null
 *    score; non-vision untested models do not.
 * 4. Profile patch: vision_capable round-trips through /api/settings/profile
 *    and is surfaced by GET /api/profile.
 * 5. Served dashboard HTML carries the Phase 6 control markers (vision toggle,
 *    dynamic role tabs, per-row pin buttons, provider roles/vision chips).
 */
import { afterAll, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import type { TestUnit } from "../../src/testunits/schema.js";

interface Harness {
  deps: ToolDeps;
  ui: UiServer;
  base: string;
}

const homes: ToolDeps[] = [];
const uis: UiServer[] = [];

async function harness(): Promise<Harness> {
  const deps = buildDeps(scratchHome());
  homes.push(deps);
  deps.profiles.createProfile({ name: "t" });
  deps.profiles.switchProfile("t");
  const ui = await startUiServer(deps, { port: 0 });
  uis.push(ui);
  return { deps, ui, base: `http://127.0.0.1:${ui.port}` };
}

function registerVisionUntested(deps: ToolDeps, profile: string, modelId: string): void {
  new ProviderModelStore(deps.db).registerManifestModel(profile, "cloudflare" as never, {
    model_id: modelId,
    context_length: null,
    vision: true,
    function_calling: true,
  });
}

function registerPlainUntested(deps: ToolDeps, profile: string, modelId: string): void {
  new ProviderModelStore(deps.db).registerManifestModel(profile, "cloudflare" as never, {
    model_id: modelId,
    context_length: null,
    vision: false,
    function_calling: true,
  });
}

function customUnit(role: string): TestUnit {
  return {
    id: `u-${role}`,
    name: "custom",
    task_group: "quality",
    difficulty: "easy",
    prompts: [{ id: "p1", text: "hi", expected: null, notes: null }],
    measures: ["quality"],
    applicable_roles: [role],
    recommended_config: {
      context_length: 4096,
      kv_cache_quant: "Q8",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.1,
      max_output_tokens: 64,
    },
    scoring: { method: "orchestrator_judged", rubric: "Was the reply useful?" },
    source: "custom_authored",
    version: 1,
  };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

afterAll(async () => {
  for (const ui of uis.splice(0)) await ui.close();
  for (const d of homes.splice(0)) {
    d.close();
    cleanup(d.home);
  }
});

describe("Phase 46 — /api/pins CRUD", () => {
  it("empty, set, re-set overwrite, delete round-trip", async () => {
    const { base } = await harness();
    const empty = await json<{ profile: string; pins: unknown[] }>(await fetch(`${base}/api/pins`));
    expect(empty.pins).toEqual([]);

    const setRes = await fetch(`${base}/api/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "vision", provider: "cloudflare", model_id: "@cf/gemma-4-26b-a4b-it" }),
    });
    const setBody = await json<{ role: string; provider: string; model_id: string; replaced: boolean }>(setRes);
    expect(setBody.replaced).toBe(false);

    const after = await json<{ pins: Array<{ role: string; provider: string; model_id: string; updated_at: string | null }> }>(await fetch(`${base}/api/pins`));
    expect(after.pins).toHaveLength(1);
    expect(after.pins[0]).toMatchObject({ role: "vision", provider: "cloudflare", model_id: "@cf/gemma-4-26b-a4b-it" });
    expect(typeof after.pins[0]!.updated_at).toBe("string");

    const againRes = await fetch(`${base}/api/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "vision", provider: "local", model_id: "lmstudio/other" }),
    });
    const again = await json<{ replaced: boolean; provider: string }>(againRes);
    expect(again.replaced).toBe(true);
    expect(again.provider).toBe("local");

    const delRes = await fetch(`${base}/api/pins?role=vision`, { method: "DELETE" });
    const delBody = await json<{ removed: boolean }>(delRes);
    expect(delBody.removed).toBe(true);
    const gone = await json<{ pins: unknown[] }>(await fetch(`${base}/api/pins`));
    expect(gone.pins).toEqual([]);
  });

  it("invalid provider is rejected with the store's code", async () => {
    const { base } = await harness();
    const res = await fetch(`${base}/api/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer", provider: "not-a-provider", model_id: "@cf/x" }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ code: string }>(res);
    expect(body.code).toBe("invalid_arguments");
  });

  it("missing role/model fields are rejected as bad_request", async () => {
    const { base } = await harness();
    const res = await fetch(`${base}/api/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "", provider: "cloudflare", model_id: "" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("bad_request");
  });
});

describe("Phase 46 — /api/roles vocabulary + counts", () => {
  it("eleven built-ins incl. vision, custom unit roles, merged row counts", async () => {
    const { deps, base } = await harness();
    deps.testUnits.register("t", customUnit("transcriber"));
    // Registry rows drive counts.
    deps.registry.upsert("t", {
      model_id: "@cf/glm-vision",
      provider: "cloudflare",
      roles: ["vision"],
      scores: { vision: 90 },
      score_minima: { vision: 60 },
      best_params: {},
      performance_score: 88,
    });
    deps.registry.upsert("t", {
      model_id: "local/llama",
      roles: ["reviewer"],
      scores: { reviewer: 60 },
      score_minima: { reviewer: 40 },
      best_params: {},
      performance_score: 80,
    });
    // An untested registered vision-capable catalog model counts toward vision
    // too (leaderboard merge parity).
    registerVisionUntested(deps, "t", "@cf/untested-vlm");

    const body = await json<{
      builtin: string[];
      custom: string[];
      roles: Array<{ role: string; kind: string; count: number }>;
    }>(await fetch(`${base}/api/roles`));

    expect(body.builtin).toHaveLength(11);
    expect(body.builtin).toContain("vision");
    expect(body.builtin).toContain("test_writer");
    expect(body.custom).toEqual(["transcriber"]);

    const vision = body.roles.find((r) => r.role === "vision");
    expect(vision).toEqual({ role: "vision", kind: "builtin", count: 2 }); // registry + untested catalog
    const reviewer = body.roles.find((r) => r.role === "reviewer");
    expect(reviewer?.count).toBe(1);
    const transcriber = body.roles.find((r) => r.role === "transcriber");
    expect(transcriber).toBeUndefined(); // no rows carry it yet — zero-count roles are vocabulary-only
  });
});

describe("Phase 46 — leaderboard ?role=vision merged rows", () => {
  it("untested registered vision-capable cloud models join the vision tab; non-vision do not", async () => {
    const { deps, base } = await harness();
    // Registry vision row.
    deps.registry.upsert("t", {
      model_id: "@cf/glm-vision",
      provider: "cloudflare",
      roles: ["vision"],
      scores: { vision: 90 },
      score_minima: { vision: 60 },
      best_params: {},
      performance_score: 88,
    });
    // Registered-but-untested vision-capable model (catalog only).
    registerVisionUntested(deps, "t", "@cf/untested-vlm");
    // Registered-but-untested plain model must NOT leak into the vision tab.
    registerPlainUntested(deps, "t", "@cf/untested-plain");

    const body = await json<{ rows: Array<{ model: string; model_id: string; provider: string | null; score: number | null }> }>(
      await fetch(`${base}/api/leaderboard?role=vision`),
    );
    const ids = body.rows.map((r) => r.model_id);
    expect(ids).toContain("@cf/glm-vision");
    expect(ids).toContain("@cf/untested-vlm");
    expect(ids).not.toContain("@cf/untested-plain");

    const untested = body.rows.find((r) => r.model_id === "@cf/untested-vlm");
    expect(untested?.score).toBeNull();
    expect(untested?.provider).toBe("cloudflare");
    // Registry vision row sorts first (score 90 > null).
    expect(body.rows[0]!.model_id).toBe("@cf/glm-vision");
  });
});

describe("Phase 46 — profile vision_capable patch", () => {
  it("default true on GET /api/profile; patch flips it off and back", async () => {
    const { base } = await harness();
    const before = await json<{ profile: { vision_capable: boolean } }>(await fetch(`${base}/api/profile?name=t`));
    expect(before.profile.vision_capable).toBe(true);

    const off = await fetch(`${base}/api/settings/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "t", vision_capable: false }),
    });
    expect(off.status).toBe(200);
    const after = await json<{ profile: { vision_capable: boolean } }>(await fetch(`${base}/api/profile?name=t`));
    expect(after.profile.vision_capable).toBe(false);

    const on = await fetch(`${base}/api/settings/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vision_capable: true }),
    });
    expect(on.status).toBe(200);
    const done = await json<{ profile: { vision_capable: boolean } }>(await fetch(`${base}/api/profile?name=t`));
    expect(done.profile.vision_capable).toBe(true);
  });
});

describe("Phase 46 — dashboard HTML markers", () => {
  it("serves the Phase 6 controls", async () => {
    const { base } = await harness();
    const body = await (await fetch(`${base}/`)).text();
    // Vision toggle in the Profile Editor + its load/save wiring.
    expect(body).toContain('id="cfgVisionCapable"');
    expect(body).toContain("vision_capable: document.getElementById('cfgVisionCapable').checked");
    expect(body).toContain("p.vision_capable");
    // Dynamic role tabs from /api/roles — the full vocabulary (builtin +
    // custom), not just roles that already carry rows, so a zero-count role
    // still gets a selectable/pinnable tab.
    expect(body).toContain('id="roleTabs"');
    expect(body).toContain("async function renderRoleTabs()");
    expect(body).toContain("'/api/roles'");
    expect(body).toContain("data.builtin");
    expect(body).toContain("data.custom");
    // Per-row pin control hitting /api/pins.
    expect(body).toContain("'/api/pins'");
    expect(body).toContain("button[data-role]");
    // Provider table roles + vision chip.
    expect(body).toContain("m.roles");
    expect(body).toContain("m.vision");
    expect(body).toContain("visionChip");
  });
});
