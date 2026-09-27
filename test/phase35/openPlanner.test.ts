/**
 * Phase 35 — dashboard open-planning (`src/ui/openSession.ts`). Pure cadence
 * rules: run/read tools open once per kind; mutation tools navigate + reload on
 * every call; the fresh `r` nonce appears only on reloads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dashboardDeepLink, openPlan, planOpen, resetOpenState, VIEW_HASH } from "../../src/ui/openSession.js";

describe("openPlan (pure)", () => {
  it("opens a non-mutation tool once per kind, then stays silent", () => {
    const seen = new Set<string>();
    const first = openPlan("run_sub_agent", { view: "live" }, seen);
    expect(first.navigate).toBe(true);
    expect(first.reload).toBe(false);
    expect(first.url).toContain("/vox-terminus?maximize=1");

    const second = openPlan("run_sub_agent", { view: "live" }, seen);
    expect(second.navigate).toBe(false);
    expect(second.url).toBeUndefined();
  });

  it("treats distinct tool kinds independently", () => {
    const seen = new Set<string>();
    expect(openPlan("run_sub_agent", { view: "live" }, seen).navigate).toBe(true);
    expect(openPlan("run_test_regimen", { view: "live" }, seen).navigate).toBe(true);
    expect(openPlan("run_sub_agent", { view: "live" }, seen).navigate).toBe(false);
  });

  it("navigates + reloads on EVERY mutation call, regardless of seen state", () => {
    const seen = new Set<string>();
    const a = openPlan("write_registry_entry", { view: "registry", mutation: true }, seen);
    const b = openPlan("write_registry_entry", { view: "registry", mutation: true }, seen);
    expect(a.navigate).toBe(true);
    expect(a.reload).toBe(true);
    expect(b.navigate).toBe(true);
    expect(b.reload).toBe(true);
  });
});

describe("planOpen (stateful)", () => {
  beforeEach(() => resetOpenState());
  afterEach(() => resetOpenState());

  it("honors once-per-kind across calls", () => {
    expect(planOpen("system_health_check", { view: "health" }).navigate).toBe(true);
    expect(planOpen("system_health_check", { view: "health" }).navigate).toBe(false);
  });

  it("resetOpenState clears the seen map", () => {
    planOpen("list_profiles", { view: "settings" });
    resetOpenState();
    expect(planOpen("list_profiles", { view: "settings" }).navigate).toBe(true);
  });
});

describe("dashboardDeepLink", () => {
  const keepPort = process.env.NANITES_UI_PORT;
  afterEach(() => {
    if (keepPort === undefined) delete process.env.NANITES_UI_PORT;
    else process.env.NANITES_UI_PORT = keepPort;
  });

  it("emits the plain view fragment without a nonce when reload is false", () => {
    process.env.NANITES_UI_PORT = "4700";
    const url = dashboardDeepLink("registry", false);
    expect(url).toBe(`http://127.0.0.1:4700/#/registry`);
  });

  it("appends a fresh r nonce only when reload is true", () => {
    process.env.NANITES_UI_PORT = "4789";
    const url = dashboardDeepLink("settings", true, 12345);
    expect(url).toBe(`http://127.0.0.1:4789/#/settings?r=12345`);
  });

  it("keeps query-bearing views (live) separated correctly", () => {
    const url = dashboardDeepLink("live", true, 1);
    expect(url).toContain(`/#${VIEW_HASH.live}&r=1`);
  });
});
