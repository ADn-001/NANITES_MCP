/**
 * Phase 6 gate — health gate in front of multi-step workflows (test suite item 4).
 *
 * Workflow #1's Phase 6 body is a stub, but it must PROVE the gate runs first:
 * a healthy endpoint proceeds to the (Phase 7) body; a down endpoint aborts
 * with health_check_failed before anything else happens. Injected recovery is
 * a no-op with waitMs 0 so the "down" path never sleeps or spawns lms.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { runTestRegimen } from "../../src/workflows/runTestRegimen.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { liveHandler } from "../phase5/helpers.js";
import { startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";

function fastRecovery() {
  return { run: async () => {}, waitMs: 0 };
}

describe("Phase 6 gate — workflow health gate", () => {
  let deps: ToolDeps;
  let live: MockLmStudio;
  let dead: MockLmStudio;

  beforeEach(async () => {
    deps = buildDeps(scratchHome());
    live = await startMockLmStudio(liveHandler);
    dead = await startMockLmStudio(liveHandler);
    await dead.close(); // release the port -> endpoint down
    deps.profiles.createProfile({ name: "t", endpoint: { url: live.url }, machine_specs: { vram_gb: 4 } });
  });

  afterEach(async () => {
    await live.close().catch(() => {});
    await dead.close().catch(() => {});
    deps.close();
    cleanup(deps.home);
  });

  it("healthy endpoint: gate passes, then the workflow body runs to a summary", async () => {
    deps.profiles.createProfile({ name: "h", endpoint: { url: live.url } });
    const summary = await runTestRegimen(deps, "h", "openai/gpt-oss-20b", { recovery: fastRecovery() });
    // The gate did not abort, so the full pipeline ran: judged units went
    // pending (the default regimen's 22 orchestrator-judged units), and the
    // registry stays absent until the judgment flow finalizes.
    expect(summary.model_id).toBe("openai/gpt-oss-20b");
    expect(summary.pending_unit_ids.length).toBeGreaterThan(0);
    expect(summary.registered_entry).toBeNull();
  });

  it("down endpoint: aborts with health_check_failed before reaching the body", async () => {
    deps.profiles.createProfile({ name: "d", endpoint: { url: dead.url } });
    const err = await runTestRegimen(deps, "d", "openai/gpt-oss-20b", { recovery: fastRecovery() }).catch(
      (e: unknown) => e,
    );
    expect((err as { code: string }).code).toBe("health_check_failed");
    expect((err as { retryable: boolean }).retryable).toBe(true);
    expect((err as { details: { overall: string } }).details.overall).toBe("down");
    expect(String((err as { message: string }).message)).toContain("Aborting workflow");
  });

  it("unknown profile: profile_not_found before any health work", async () => {
    const err = await runTestRegimen(deps, "missing", "openai/gpt-oss-20b", { recovery: fastRecovery() }).catch(
      (e: unknown) => e,
    );
    expect((err as { code: string }).code).toBe("profile_not_found");
  });
});
