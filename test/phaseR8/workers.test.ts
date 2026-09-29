/**
 * R8b — persistent workers, per-feature flags, and the Needle repair rung.
 *
 * The tests here are the ones that catch the failure modes that only appear
 * once a helper is a LONG-LIVED process rather than a per-call spawn. That
 * change is what makes the feature usable and what introduced the bug this
 * file is mostly about.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HelperWorker, workerPath } from "../../src/router/helpers/workerClient.js";
import { multiToolSource, schemaSourceFor, pyDoc, pyLiteral } from "../../src/router/helpers/schemaSource.js";
import { HELPER_FEATURES, HELPER_FEATURE_NAMES, featureColumn, isHelperFeature } from "../../src/router/helpers/features.js";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { updateConfig } from "../../src/router/auth.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];
const workers: HelperWorker[] = [];

afterEach(async () => {
  while (workers.length) await workers.pop()!.stop();
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

async function harness() {
  const h = scratchHome();
  homes.push(h);
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  return handle;
}

const READ_FILE = {
  name: "read_file",
  description: "Read the contents of a file at an absolute path and return its text.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "the absolute path of the file to read" } },
    required: ["path"],
  },
};

describe("generated Python source is safe to embed", () => {
  it("emits the tool under its WIRE name, not the Python symbol", () => {
    // Measured: handing Needle a dataclass makes it report `ReadFile` where
    // the contract is `read_file`, which failed every comparison.
    const src = multiToolSource([READ_FILE]);
    expect(src).toContain("def read_file(path: str):");
    expect(src).toContain("TOOLS = [read_file]");
  });

  it("never emits an executable tool body", () => {
    // The single most important property in this file. If a body were
    // reachable, the repair rung would execute what it reconstructed.
    const src = multiToolSource([READ_FILE]);
    expect(src).toContain("raise NotImplementedError");
    expect(src).not.toMatch(/^\s*open\(/m);
  });

  it("escapes a description that would otherwise close the docstring early", () => {
    const nasty = {
      ...READ_FILE,
      description: 'ends with a quote" and a """ inside',
    };
    const src = multiToolSource([nasty]);
    // The generated program must still be syntactically valid Python.
    expect(() => pyDoc(nasty.description)).not.toThrow();
    // Count triple-quote delimiters: an odd number would mean the docstring
    // was terminated by the content rather than by the delimiter.
    const triples = (src.match(/"""/g) ?? []).length;
    expect(triples % 2).toBe(0);
  });

  it("maps JSON Schema types to the spellings a dataclass annotation needs", () => {
    const src = schemaSourceFor("Record", {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "integer" }, d: { type: "boolean" } },
      required: ["a", "b", "c", "d"],
    });
    expect(src).toContain("a: str");
    expect(src).toContain("b: float");
    expect(src).toContain("c: int");
    expect(src).toContain("d: bool");
  });

  it("rejects a tool with no usable arguments rather than emitting a broken class", () => {
    expect(() => multiToolSource([{ name: "ping", description: "ping", parameters: {} }])).toThrow();
  });

  it("drops a field whose name is not a valid identifier", () => {
    const src = schemaSourceFor("Record", {
      type: "object",
      properties: { "not-an-ident": { type: "string" }, ok: { type: "string" } },
      required: ["ok"],
    });
    expect(src).toContain("ok: str");
    expect(src).not.toContain("not-an-ident:");
  });

  it("quotes a literal with an embedded quote", () => {
    expect(pyLiteral('a "b" c')).toBe('"a \\"b\\" c"');
  });
});

describe("per-feature flags", () => {
  it("names a column for every declared feature", () => {
    // A feature added to HELPER_FEATURES without a column would be a setting
    // that silently does nothing, which is exactly the failure class the
    // whitelist is meant to prevent.
    for (const name of HELPER_FEATURE_NAMES) {
      expect(featureColumn(name)).toBe(`feature_${name}`);
      expect(isHelperFeature(name)).toBe(true);
    }
    expect(isHelperFeature("nope")).toBe(false);
  });

  it("carries the measurement behind each feature", () => {
    // The evidence lives in the code, so the next person to ask "why is this
    // default off" does not have to go looking for a benchmark.
    for (const name of HELPER_FEATURE_NAMES) {
      expect(HELPER_FEATURES[name].evidence.length).toBeGreaterThan(10);
    }
  });

  it("defaults every feature OFF, including the ones the eval supports", async () => {
    const h = await harness();
    const cols = db(h).prepare("PRAGMA table_info(router_config)").all() as Array<{ name: string }>;
    for (const name of HELPER_FEATURE_NAMES) {
      expect(cols.some((c) => c.name === featureColumn(name))).toBe(true);
      const row = db(h).prepare(`SELECT ${featureColumn(name)} AS v FROM router_config WHERE id = 1`).get() as { v: number };
      expect(row.v).toBe(0);
    }
  });

  it("turns the master gate off for every feature at once", async () => {
    const h = await harness();
    updateConfig(db(h), { enable_helpers: true, feature_tool_repair: true, feature_structured_output: true });
    const on = db(h).prepare("SELECT enable_helpers, feature_tool_repair FROM router_config WHERE id = 1").get() as Record<string, number>;
    expect(on["enable_helpers"]).toBe(1);
    expect(on["feature_tool_repair"]).toBe(1);

    // The user-facing promise: turning helpers off stops them being used.
    updateConfig(db(h), { enable_helpers: false });
    const { readHelperFlags } = await import("../../src/router/helpers/registry.js");
    const flags = readHelperFlags(db(h));
    expect(flags.enabled).toBe(false);
    // The feature columns keep their stored values, but every EFFECTIVE flag
    // is off, so no in-flight path can reach a helper.
    const stored = db(h).prepare("SELECT feature_tool_repair AS v FROM router_config WHERE id = 1").get() as { v: number };
    expect(stored.v).toBe(1);
    for (const name of HELPER_FEATURE_NAMES) expect(flags.features[name]).toBe(false);
  });

  it("round-trips a feature flag through the CONFIG ROW MAPPER", async () => {
    // The bug this catches: `rowToConfig` builds an explicit object, so a
    // column the type declares but the mapper omits is dropped. The write
    // landed, the read was undefined, and every feature reported false
    // forever while the database said 1. Found only by running the built
    // server and clicking the switch — no unit test saw it, because every
    // test read the flag through the same broken mapper.
    const h = await harness();
    updateConfig(db(h), { enable_helpers: true, feature_tool_repair: true });

    const raw = db(h).prepare("SELECT feature_tool_repair AS v FROM router_config WHERE id = 1").get() as { v: number };
    expect(raw.v).toBe(1);

    const { readConfig } = await import("../../src/router/auth.js");
    expect(readConfig(db(h))!.feature_tool_repair).toBe(1);

    const { readHelperFlags } = await import("../../src/router/helpers/features.js");
    expect(readHelperFlags(db(h)).features.tool_repair).toBe(true);
  });

  it("reports a missing column as 0, never NaN", async () => {
    // NaN is falsy but serialises to null, so a flag would render as "off"
    // with no way to tell it apart from a genuinely-off flag.
    const h = await harness();
    const { readConfig } = await import("../../src/router/auth.js");
    const row = readConfig(db(h))!;
    for (const name of HELPER_FEATURE_NAMES) {
      const v = row[featureColumn(name) as never];
      expect(typeof v).toBe("number");
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it("rejects an unknown feature key", async () => {
    const h = await harness();
    let code: string | null = null;
    try { updateConfig(db(h), { feature_not_a_thing: true } as never); } catch (e) { code = (e as { code: string }).code; }
    expect(code).toBe("router_invalid_request");
  });
});

function db(h: StartedRouter) { return h.deps.db; }

describe("the worker protocol", () => {
  it("never lets a greeting occupy the first reply slot", async () => {
    // THE regression. An unsolicited `{"warmed":true}` on startup shifts
    // every reply by one: measured 6 calls, 6 replies, each the PREVIOUS
    // call's answer — including a confident, wrong tool call for a request
    // that was not a tool call at all.
    const w = new HelperWorker({ name: "test", script: workerPath("./needle_worker.py"), timeoutMs: 180_000 });
    workers.push(w);

    // Assert the SHIFT, not just that calls succeed. Three identical pings
    // all returning ok is exactly what a shifted worker also produces — the
    // greeting is consumed as reply #1 and every later reply is the PREVIOUS
    // request's answer. A test written that way passed against the bug.
    //
    // The observable difference: with a greeting, the FIRST reply is the
    // handshake, which carries `warmed` and nothing else. A real reply to
    // `ping` carries `warmed` too, so the discriminator is a request whose
    // reply MUST echo its own marker.
    const a = await w.send({ op: "ping", tag: "first" });
    expect(a.ok).toBe(true);
    const b = await w.send({ op: "embed", text: "marker-second-request" });
    expect(b.ok).toBe(true);
    // The second reply belongs to the SECOND request. If a greeting shifted
    // the queue, this is the first request's handshake and carries no vector.
    expect(Array.isArray(b["vector"])).toBe(true);
    const c = await w.send({ op: "ping" });
    expect(c.ok).toBe(true);
  });

  it("answers a bad request without dying", async () => {
    const w = new HelperWorker({ name: "test", script: workerPath("./needle_worker.py"), timeoutMs: 180_000 });
    workers.push(w);
    const bad = await w.send({ op: "not_a_real_op" });
    expect(bad.ok).toBe(false);
    // Still alive and answering afterwards.
    const after = await w.send({ op: "ping" });
    expect(after.ok).toBe(true);
  });

  it("reports a missing interpreter instead of throwing", async () => {
    const w = new HelperWorker({
      name: "test",
      script: workerPath("./needle_worker.py"),
      python: "definitely-not-python-xyz",
      timeoutMs: 5000,
    });
    workers.push(w);
    const res = await w.send({ op: "ping" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/python/i);
  });

  it("respawns after being discarded", async () => {
    const w = new HelperWorker({ name: "test", script: workerPath("./needle_worker.py"), timeoutMs: 180_000 });
    workers.push(w);
    expect((await w.send({ op: "ping" })).ok).toBe(true);
    w.discard("test");
    expect(w.running()).toBe(false);
    // The NEXT request starts a fresh one rather than failing forever.
    expect((await w.send({ op: "ping" })).ok).toBe(true);
    expect(w.running()).toBe(true);
  });
});
