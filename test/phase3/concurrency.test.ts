import { afterAll, describe, expect, it } from "vitest";
import { openNanitesDb } from "../../src/storage/db.js";
import { RegistryStore } from "../../src/storage/registryStore.js";
import { ProfileManager } from "../../src/storage/profileManager.js";
import { cleanup, scratchHome } from "./helpers.js";

/**
 * Concurrent-write safety. Writes are synchronous and atomic (temp + rename),
 * so rapid concurrent callers serialize at the event loop with
 * last-write-wins semantics: the final state is one complete write, never a
 * torn mix, and the file/DB always parses.
 */
describe("concurrent writes — registry (SQLite)", () => {
  const home = scratchHome();
  const { db, close } = openNanitesDb(home);
  const registry = new RegistryStore(db);

  it("two rapid upserts to the same entry yield one coherent, parseable final state", async () => {
    const a = { model_id: "m1", roles: ["code"], scores: { quality: 7 }, best_params: { temperature: 0.2 }, last_tested: "2026-01-01T00:00:00.000Z" };
    const b = { model_id: "m1", roles: ["summary"], scores: { quality: 9 }, best_params: { temperature: 0.8 }, last_tested: "2026-02-01T00:00:00.000Z" };

    await Promise.all([
      Promise.resolve().then(() => registry.upsert("main", a)),
      Promise.resolve().then(() => registry.upsert("main", b)),
    ]);

    const final = registry.get("main", "m1");
    expect(final).not.toBeNull();
    // No torn state: JSON columns must parse, and the whole entry must equal
    // exactly one of the two complete writes (last-write-wins).
    const cleanShape = (x: typeof a) => ({
      model_id: x.model_id,
      roles: x.roles,
      scores: x.scores,
      best_params: x.best_params,
      last_tested: x.last_tested,
    });
    const finalClean = cleanShape(final!);
    expect([cleanShape(a), cleanShape(b)]).toContainEqual(finalClean);
  });

  afterAll(() => {
    close();
    cleanup(home);
  });
});

describe("concurrent writes — profile (JSON)", () => {
  const home = scratchHome();
  const pm = new ProfileManager(home);

  it("two rapid updates to the same profile leave valid JSON with a deterministic winner", async () => {
    pm.createProfile({ name: "p" });
    await Promise.all([
      Promise.resolve().then(() => pm.updateProfile("p", { use_case: "first" })),
      Promise.resolve().then(() => pm.updateProfile("p", { use_case: "second" })),
    ]);
    const final = pm.getProfile("p");
    expect(final).not.toBeNull();
    expect(["first", "second"]).toContain(final!.use_case);
    // Whole profile is internally consistent — no field torn between writes.
    expect(final!.name).toBe("p");
    expect(final!.machine_specs.vram_gb).toBe(4); // untouched default from create
  });

  it("registry and profile can be written concurrently without cross-corruption", async () => {
    const { db, close } = openNanitesDb(home);
    const registry = new RegistryStore(db);
    await Promise.all([
      Promise.resolve().then(() => pm.updateProfile("p", { use_case: "x" })),
      Promise.resolve().then(() => registry.upsert("p", { model_id: "m", roles: [], scores: {}, best_params: {}, last_tested: null })),
    ]);
    expect(pm.getProfile("p")!.use_case).toBe("x");
    expect(registry.get("p", "m")).not.toBeNull();
    close();
  });

  afterAll(() => {
    cleanup(home);
  });
});
