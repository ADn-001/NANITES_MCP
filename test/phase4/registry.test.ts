import { afterAll, describe, expect, it } from "vitest";
import { openNanitesDb } from "../../src/storage/db.js";
import { TestUnitRegistry } from "../../src/testunits/registry.js";
import { DEFAULT_REGIMEN } from "../../src/testunits/defaultRegimen.js";
import { NanitesError } from "../../src/helpers/errors.js";
import type { TestUnit } from "../../src/testunits/schema.js";
import { cleanup, scratchHome } from "../phase3/helpers.js";

const home = scratchHome();
const { db, close } = openNanitesDb(home);
const registry = new TestUnitRegistry(db);

function cloneValid(): TestUnit {
  return JSON.parse(JSON.stringify(DEFAULT_REGIMEN[0]!)) as TestUnit;
}

describe("TestUnitRegistry — register validates in the same call chain (no bypass, gate 4)", () => {
  it("refuses a unit that fails validation, with the issues surfaced", () => {
    const broken = cloneValid();
    broken.scoring = { method: "orchestrator_judged" }; // no rubric
    try {
      registry.register("main", broken);
      expect.unreachable("register should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NanitesError);
      const e = err as NanitesError;
      expect(e.toShape().code).toBe("test_unit_invalid");
      expect(e.toShape().details?.issues).toBeTruthy();
    }
  });

  it("does not trust a 'valid-looking' unit — a unit that previously passed elsewhere is re-validated on every register", () => {
    // Take a unit straight from the validated default regimen, mutate it to be
    // invalid, and confirm register still rejects it (no caching of prior state).
    const valid = cloneValid();
    expect(valid.scoring.method).toBe("orchestrator_judged");
    valid.prompts = []; // now invalid
    expect(() => registry.register("main", valid)).toThrowError(/prompts/);
  });

  it("registers a valid unit and round-trips through list/get", () => {
    const unit = cloneValid();
    unit.id = "custom-registered";
    registry.register("main", unit);
    const listed = registry.list("main");
    expect(listed.map((u) => u.id)).toContain("custom-registered");
    expect(registry.get("main", "custom-registered")?.name).toBe(unit.name);
  });

  it("rejects a duplicate id within the registered set", () => {
    const dupe = cloneValid();
    dupe.id = "custom-registered"; // already registered above
    expect(() => registry.register("main", dupe)).toThrowError(/duplicate id/);
  });

  it("registerDefaultRegimen registers all 29 and is idempotent", () => {
    const registered = registry.registerDefaultRegimen("main");
    expect(registered).toHaveLength(29);
    expect(registry.list("main")).toHaveLength(30); // 29 regimen + the custom unit registered earlier
    // Idempotent: a second run registers nothing new, never duplicates or throws.
    const again = registry.registerDefaultRegimen("main");
    expect(again).toHaveLength(0);
    expect(registry.list("main")).toHaveLength(30);
  });

  it("is scoped per profile", () => {
    expect(registry.list("other")).toHaveLength(0);
    registry.register("other", cloneValid());
    expect(registry.list("other")).toHaveLength(1);
    expect(registry.list("main")).toHaveLength(30); // untouched
  });

  it("remove deletes and reports success", () => {
    expect(registry.remove("other", DEFAULT_REGIMEN[0]!.id)).toBe(true);
    expect(registry.get("other", DEFAULT_REGIMEN[0]!.id)).toBeNull();
  });
});

afterAll(() => {
  close();
  cleanup(home);
});
