import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type CallResult, type ToolHarness } from "./helpers.js";

// ---- fixtures ----

function validUnit(): Record<string, unknown> {
  return {
    id: "u1",
    name: "Sample",
    task_group: "task1",
    difficulty: "easy",
    prompts: [{ id: "a", text: "Do the thing." }],
    measures: ["quality"],
    applicable_roles: ["code_qa"],
    recommended_config: {
      context_length: 8000,
      kv_cache_quant: "Q8",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.1,
      max_output_tokens: 400,
    },
    scoring: { method: "orchestrator_judged", rubric: "Correctness matters; honesty matters; conciseness matters." },
    source: "custom_authored",
    version: 1,
  };
}

function brokenUnit(): Record<string, unknown> {
  const unit = validUnit();
  unit.scoring = { method: "orchestrator_judged" }; // no rubric
  return unit;
}

function expectStructuredError(res: CallResult, code?: string): void {
  expect(res.ok).toBe(false);
  expect(res.error).toBeTruthy();
  expect(typeof res.error!.code).toBe("string");
  expect(typeof res.error!.message).toBe("string");
  expect(typeof res.error!.retryable).toBe("boolean");
  if (code) expect(res.error!.code).toBe(code);
}

function expectSchemaRejected(raw: { isError: boolean; text: string }): void {
  expect(raw.isError, "invalid input is surfaced as an MCP error, not a handler result").toBe(true);
  // Either the schema-level message (handler present) or the request-layer one
  // (arguments not a record at all).
  expect(raw.text).toMatch(/Invalid (arguments for tool|tools\/call request)/);
}

// ---- model / inference ----

describe("Phase 5 gate — model/inference tools", () => {
  let h: ToolHarness;
  let dead: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
    dead = await createHarness({ dead: true });
  });
  afterAll(async () => {
    await h.close();
    await dead.close();
  });

  it("list_models — happy path returns a trimmed shape; verbose returns full objects", async () => {
    const res = await h.callTool("list_models", {});
    expect(res.ok).toBe(true);
    const data = res.data as { models: Array<Record<string, unknown>> };
    expect(data.models).toHaveLength(2);
    expect(data.models[0]!.model).toBe("gemma-3-270m-it-qat");
    expect(data.models[0]!.loaded_instance_ids).toEqual(["gemma-3-270m-it-qat"]);
    expect(data.models[0]!.params_string).toBe("270M");

    const verbose = await h.callTool("list_models", { verbose: true });
    expect((verbose.data as { models: Array<Record<string, unknown>> }).models[0]!.publisher).toBe("lmstudio-community");
    expect((verbose.data as { models: Array<Record<string, unknown>> }).models[0]!.loaded_instances).toHaveLength(1);
  });
  it("list_models — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("list_models", { verbose: "yes" }));
  });
  it("list_models — induced failure: structured error, not an unhandled exception", async () => {
    expectStructuredError(await dead.callTool("list_models", {}), "connection_refused");
  });

  it("get_loaded_model — happy path returns only loaded models", async () => {
    const res = await h.callTool("get_loaded_model", {});
    expect(res.ok).toBe(true);
    expect((res.data as { models: unknown[] }).models).toHaveLength(1);
  });
  it("get_loaded_model — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("get_loaded_model", { verbose: 42 }));
  });
  it("get_loaded_model — induced failure: structured error", async () => {
    expectStructuredError(await dead.callTool("get_loaded_model", {}), "connection_refused");
  });

  it("load_model — happy path returns the load response", async () => {
    const res = await h.callTool("load_model", { model_id: "openai/gpt-oss-20b", params: { context_length: 16384 } });
    expect(res.ok).toBe(true);
    expect((res.data as { instance_id: string }).instance_id).toBe("openai/gpt-oss-20b");
    expect((res.data as { status: string }).status).toBe("loaded");
  });
  it("load_model — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("load_model", { model_id: "" }));
  });
  it("load_model — induced failure: structured error", async () => {
    expectStructuredError(await dead.callTool("load_model", { model_id: "openai/gpt-oss-20b" }), "connection_refused");
  });

  it("unload_model — happy path returns the instance id", async () => {
    const res = await h.callTool("unload_model", { instance_id: "openai/gpt-oss-20b" });
    expect(res.ok).toBe(true);
    expect((res.data as { instance_id: string }).instance_id).toBe("openai/gpt-oss-20b");
  });
  it("unload_model — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("unload_model", {}));
  });
  it("unload_model — induced failure: structured error", async () => {
    expectStructuredError(await dead.callTool("unload_model", { instance_id: "openai/gpt-oss-20b" }), "connection_refused");
  });

  it("chat — happy path returns cleaned reply plus validation field", async () => {
    const res = await h.callTool("chat", {
      instance_id: "qwen/qwen3-vl-4b",
      messages: [{ role: "user", content: "Describe this image." }],
    });
    expect(res.ok).toBe(true);
    const data = res.data as { reply: string; stats: { input_tokens: number }; validation: { cleaned: boolean; issues: string[] } };
    expect(data.reply).toContain("This image");
    expect(data.stats.input_tokens).toBe(17);
    expect(data.validation.cleaned).toBe(false);
    expect(data.validation.issues).toEqual([]);
  });
  it("chat — schema rejection (missing content)", async () => {
    expectSchemaRejected(await h.callToolRaw("chat", { instance_id: "x", messages: [{ role: "system" }] }));
  });
  it("chat — induced failure: structured error", async () => {
    expectStructuredError(
      await dead.callTool("chat", { instance_id: "x", messages: [{ role: "user", content: "hi" }] }),
      "connection_refused",
    );
  });

  it("download_model — happy path returns the job", async () => {
    const res = await h.callTool("download_model", { source: "microsoft/phi-4-mini", quantization: "Q4_K_M" });
    expect(res.ok).toBe(true);
    expect((res.data as { job_id: string }).job_id).toBe("job_493c7c9ded");
    expect((res.data as { status: string }).status).toBe("downloading");
  });
  it("download_model — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("download_model", {}));
  });
  it("download_model — induced failure: structured error", async () => {
    expectStructuredError(await dead.callTool("download_model", { source: "microsoft/phi-4-mini" }), "connection_refused");
  });

  it("get_download_status — happy path", async () => {
    const res = await h.callTool("get_download_status", { job_id: "job_493c7c9ded" });
    expect(res.ok).toBe(true);
    expect((res.data as { status: string }).status).toBe("completed");
  });
  it("get_download_status — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("get_download_status", { job_id: 123 }));
  });
  it("get_download_status — induced failure: structured error", async () => {
    expectStructuredError(await dead.callTool("get_download_status", { job_id: "job_493c7c9ded" }), "connection_refused");
  });
});

// ---- registry ----

describe("Phase 5 gate — registry tools", () => {
  let h: ToolHarness;
  let broken: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
    // E5-side: registry roles/scores are role-keyed against the canonical role
    // vocabulary (built-in roles + registered test-unit roles) — a junk key
    // like `quality` is now rejected/backfilled, so the fixture uses a role.
    h.deps.registry.upsert("t", { model_id: "m1", roles: ["code_writer"], scores: { code_writer: 4 }, best_params: {}, last_tested: null });
    // `broken`: same build, but the storage DB is closed — every storage-backed
    // tool must surface a structured unexpected_error, never crash.
    broken = await createHarness();
    broken.deps.close();
  });
  afterAll(async () => {
    await h.close();
    await broken.close();
  });

  it("read_registry — happy path: by model_id and full list, trimmed by default", async () => {
    const one = await h.callTool("read_registry", { profile: "t", model_id: "m1" });
    expect(one.ok).toBe(true);
    const entries = (one.data as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.roles).toEqual(["code_writer"]);
    expect(entries[0]!.created_at).toBeUndefined();

    const verbose = await h.callTool("read_registry", { profile: "t", model_id: "m1", verbose: true });
    expect((verbose.data as { entries: Array<Record<string, unknown>> }).entries[0]!.created_at).toBeTruthy();
  });
  it("read_registry — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("read_registry", { profile: "" }));
  });
  it("read_registry — induced failure: structured error when storage is down", async () => {
    expectStructuredError(await broken.callTool("read_registry", { profile: "t", model_id: "m1" }), "unexpected_error");
  });

  it("write_registry_entry — happy path upserts and persists", async () => {
    const res = await h.callTool("write_registry_entry", {
      profile: "t",
      model_id: "m2",
      entry: { roles: ["reviewer"], scores: { reviewer: 5 } },
    });
    expect(res.ok).toBe(true);
    const stored = h.deps.registry.get("t", "m2");
    expect(stored?.roles).toEqual(["reviewer"]);
    expect(stored?.scores.reviewer).toBe(5);
    // A role-keyed write without explicit minima defaults to a single-sample
    // floor so the entry never reads as unbacked by the E3 low-confidence check.
    expect(stored?.score_minima?.reviewer).toBe(5);
  });
  it("write_registry_entry — schema rejection (score not a number)", async () => {
    expectSchemaRejected(
      await h.callToolRaw("write_registry_entry", { profile: "t", model_id: "m2", entry: { scores: { quality: "x" } } }),
    );
  });
  it("write_registry_entry — induced failure: structured error when storage is down", async () => {
    expectStructuredError(
      await broken.callTool("write_registry_entry", { profile: "t", model_id: "m2", entry: { roles: ["x"] } }),
      "unexpected_error",
    );
  });
});

// ---- profiles ----

describe("Phase 5 gate — profile tools", () => {
  let h: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("create_profile — happy path applies defaults and derives concurrency", async () => {
    const res = await h.callTool("create_profile", { name: "p2" });
    expect(res.ok).toBe(true);
    const data = res.data as { name: string; machine_specs: { vram_gb: number }; concurrency: { mode: string } };
    expect(data.name).toBe("p2");
    expect(data.machine_specs.vram_gb).toBe(4); // baseline
    expect(data.concurrency.mode).toBe("sequential");
  });
  it("create_profile — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("create_profile", { name: "" }));
  });
  it("create_profile — induced failure: duplicate name is a structured error", async () => {
    expectStructuredError(await h.callTool("create_profile", { name: "t" }), "profile_exists");
  });

  it("switch_profile — happy path makes the profile active, then restores", async () => {
    const res = await h.callTool("switch_profile", { name: "p2" });
    expect(res.ok).toBe(true);
    expect((res.data as { name: string }).name).toBe("p2");
    expect(h.deps.profiles.getActiveProfile()?.name).toBe("p2");
    await h.callTool("switch_profile", { name: "t" });
    expect(h.deps.profiles.getActiveProfile()?.name).toBe("t");
  });
  it("switch_profile — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("switch_profile", {}));
  });
  it("switch_profile — induced failure: missing profile is a structured error", async () => {
    expectStructuredError(await h.callTool("switch_profile", { name: "nope" }), "profile_not_found");
  });

  it("list_profiles — happy path returns names", async () => {
    const res = await h.callTool("list_profiles", {});
    expect(res.ok).toBe(true);
    expect((res.data as { profiles: string[] }).profiles).toContain("t");
  });
  it("list_profiles — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("list_profiles", { verbose: 3 }));
  });
  it("list_profiles — induced failure: corrupt profile file is a structured error", async () => {
    const file = `${h.deps.home}/profiles/p2.json`;
    const fs = await import("node:fs");
    fs.writeFileSync(file, "{ not valid json");
    expectStructuredError(await h.callTool("list_profiles", { verbose: true }), "profile_corrupt");
  });

  it("get_active_profile — happy path returns the active profile", async () => {
    const res = await h.callTool("get_active_profile", {});
    expect(res.ok).toBe(true);
    expect((res.data as { profile: { name: string } }).profile?.name).toBe("t");
  });
  it("get_active_profile — schema rejection (non-object arguments)", async () => {
    expectSchemaRejected(await h.callToolRaw("get_active_profile", 5));
  });
  it("get_active_profile — induced failure: corrupt profile file is a structured error", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(`${h.deps.home}/profiles/t.json`, "{ nope");
    expectStructuredError(await h.callTool("get_active_profile", {}), "profile_corrupt");
  });
});

// ---- test units ----

describe("Phase 5 gate — test-unit tools", () => {
  let h: ToolHarness;
  let broken: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
    h.deps.testUnits.register("t", validUnit()); // register under id u1 via the store directly
    broken = await createHarness();
    broken.deps.close();
  });
  afterAll(async () => {
    await h.close();
    await broken.close();
  });

  it("list_test_units — happy path lists registered units", async () => {
    const res = await h.callTool("list_test_units", { profile: "t" });
    expect(res.ok).toBe(true);
    expect((res.data as { units: Array<{ id: string }> }).units.map((u) => u.id)).toContain("u1");
  });
  it("list_test_units — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("list_test_units", { profile: "" }));
  });
  it("list_test_units — induced failure: structured error when storage is down", async () => {
    expectStructuredError(await broken.callTool("list_test_units", { profile: "t" }), "unexpected_error");
  });

  it("validate_test_unit — happy path reports ok with zero issues", async () => {
    const res = await h.callTool("validate_test_unit", { unit: validUnit() });
    expect(res.ok).toBe(true);
    expect((res.data as { ok: boolean; issues: unknown[] }).ok).toBe(true);
    expect((res.data as { issues: unknown[] }).issues).toEqual([]);
  });
  it("validate_test_unit — schema rejection (unit is not an object)", async () => {
    expectSchemaRejected(await h.callToolRaw("validate_test_unit", { unit: 42 }));
  });
  it("validate_test_unit — broken unit is reported as data, never an unhandled exception", async () => {
    const res = await h.callTool("validate_test_unit", { unit: brokenUnit() });
    expect(res.ok).toBe(true); // still a structured envelope
    const data = res.data as { ok: boolean; issues: Array<{ field: string }> };
    expect(data.ok).toBe(false);
    expect(data.issues.length).toBeGreaterThan(0);
    expect(data.issues.some((i) => i.field === "scoring.rubric")).toBe(true);
  });

  it("register_test_unit — happy path persists a valid unit", async () => {
    const unit = validUnit() as Record<string, unknown>;
    unit.id = "u-reg";
    const res = await h.callTool("register_test_unit", { profile: "t", unit });
    expect(res.ok).toBe(true);
    expect((res.data as { unit: { id: string } }).unit.id).toBe("u-reg");
  });
  it("register_test_unit — schema rejection (unit is a string)", async () => {
    expectSchemaRejected(await h.callToolRaw("register_test_unit", { profile: "t", unit: "nope" }));
  });
  it("register_test_unit — induced failure: invalid unit is a structured error with issues", async () => {
    const res = await h.callTool("register_test_unit", { profile: "t", unit: brokenUnit() });
    expectStructuredError(res, "test_unit_invalid");
    expect((res.error!.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });
});

// ---- workflow tools (get_cost_saved_report implemented in Phase 10) ----

describe("Phase 5 gate — get_cost_saved_report (implemented in Phase 10)", () => {
  let h: ToolHarness;
  let dead: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
    dead = await createHarness({ dead: true });
  });
  afterAll(async () => {
    await h.close();
    await dead.close();
  });

  it("happy path returns a real report from logged usage, not a stub", async () => {
    h.deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 100, tokens_out: 50, duration_ms: 10 });
    const res = await h.callTool("get_cost_saved_report", { profile: "t" });
    expect(res.ok).toBe(true);
    expect((res.data as { calls: number }).calls).toBe(1);
  });

  it("schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("get_cost_saved_report", { profile: "" }));
  });

  it("report is local-only: still works with LM Studio down, never crashes", async () => {
    dead.deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 100, tokens_out: 50, duration_ms: 10 });
    const res = await dead.callTool("get_cost_saved_report", { profile: "t" });
    expect(res.ok).toBe(true);
    expect((res.data as { calls: number }).calls).toBe(1);
  });
});

// ---- Phase 6 tools (implemented in Phase 6; exercised here at the tool level) ----

describe("Phase 6 tools — system_health_check + send_ntfy (implemented)", () => {
  let h: ToolHarness;
  let dead: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
    dead = await createHarness({ dead: true });
  });
  afterAll(async () => {
    await h.close();
    await dead.close();
  });

  it("system_health_check — happy path: reachable endpoint reports healthy", async () => {
    const res = await h.callTool("system_health_check", { profile: "t" });
    expect(res.ok).toBe(true);
    const data = res.data as { overall: string; reachable: boolean; recovery_attempted: boolean; checks: { endpoint: string } };
    expect(data.overall).toBe("healthy");
    expect(data.reachable).toBe(true);
    expect(data.recovery_attempted).toBe(false);
    expect(data.checks.endpoint).toBe("ok");
  });

  it("system_health_check — induced failure: dead endpoint reports down, never crashes", async () => {
    const res = await dead.callTool("system_health_check", { profile: "t" });
    expect(res.ok).toBe(true); // still a structured envelope
    const data = res.data as { overall: string; reachable: boolean; recovery_attempted: boolean };
    expect(data.overall).toBe("down");
    expect(data.reachable).toBe(false);
    expect(data.recovery_attempted).toBe(true);
  });

  it("system_health_check — schema rejection + unknown profile", async () => {
    expectSchemaRejected(await h.callToolRaw("system_health_check", { profile: 9 }));
    expectStructuredError(await h.callTool("system_health_check", { profile: "nope" }), "profile_not_found");
  });

  it("send_ntfy — happy path: no topic configured is a silent no-op", async () => {
    const res = await h.callTool("send_ntfy", { profile: "t", message: "hi" });
    expect(res.ok).toBe(true);
    const data = res.data as { sent: boolean; reason: string | null };
    expect(data.sent).toBe(false);
    expect(data.reason).toBe("no_topic");
  });

  it("send_ntfy — induced failure: dead endpoint never fails the caller", async () => {
    dead.deps.profiles.createProfile({
      name: "n",
      ntfy: { topic: "nanites", server_url: dead.mock.url },
    });
    const res = await dead.callTool("send_ntfy", { profile: "n", message: "hi" });
    expect(res.ok).toBe(true); // fire-and-forget: no throw, no error envelope
    expect((res.data as { sent: boolean }).sent).toBe(false);
  });

  it("send_ntfy — schema rejection", async () => {
    expectSchemaRejected(await h.callToolRaw("send_ntfy", { profile: "t" }));
  });
});

// ---- surface hygiene ----

describe("Phase 5 gate — surface hygiene", () => {
  it("full tool list is present via the MCP handshake, every description non-empty", async () => {
    const h = await createHarness();
    const expected = [
      "list_models", "get_loaded_model", "load_model", "unload_model", "chat", "download_model", "get_download_status",
      "read_registry", "write_registry_entry",
      "create_profile", "switch_profile", "list_profiles", "get_active_profile",
      "list_test_units", "validate_test_unit", "register_test_unit",
      "run_test_regimen", "get_pending_judgments", "submit_test_judgment", "get_cost_saved_report",
      "system_health_check", "send_ntfy",
    ];
    // Reuse a fresh client to also cover listTools separately from callTool.
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { buildServer } = await import("../../src/server/buildServer.js");
    const server = buildServer({ home: h.deps.home, deps: h.deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "phase5-hygiene", version: "0.0.1" });
    await server.server.connect(st);
    await client.connect(ct);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of expected) expect(names).toContain(name);
    for (const tool of tools) expect(tool.description?.trim().length).toBeGreaterThan(0);
    await client.close();
    await server.close();
    await h.close();
  });

  it("context budget: flags (not fails) if tool schemas+descriptions blow the soft budget", async () => {
    const h = await createHarness();
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { buildServer } = await import("../../src/server/buildServer.js");
    const server = buildServer({ home: h.deps.home, deps: h.deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "phase5-budget", version: "0.0.1" });
    await server.server.connect(st);
    await client.connect(ct);
    const { tools } = await client.listTools();
    let total = 0;
    for (const tool of tools) {
      total += (tool.description?.length ?? 0) + JSON.stringify(tool.inputSchema).length;
    }
    // eslint-disable-next-line no-console
    console.log(`[phase5] tool surface context budget: ${total} chars`);
    // Hard ceiling guards against pathological bloat; soft budget is a flag only.
    expect(total).toBeLessThan(60_000);
    await client.close();
    await server.close();
    await h.close();
  });
});
