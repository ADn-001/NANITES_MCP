/**
 * R6 — tool-call argument repair.
 *
 * The bug this replaces: a malformed `arguments` string became `{}` and the
 * call STILL EXECUTED. A `write_file` with no path, a `search_files` matching
 * nothing, a crash inside the tool — with nothing in the response saying the
 * model's intent had been thrown away.
 *
 * The corpus is table-driven, one `it` per malformation, so a failure NAMES the
 * broken case. A single looping test says "corpus failed" and tells you
 * nothing.
 */
import { describe, expect, it } from "vitest";
import {
  repairToolArguments,
  repairToolArgumentsValue,
  repairAndValidate,
  validateAgainstSchema,
  extractBalanced,
  coerce,
  closeTruncated,
} from "../../src/helpers/toolCallRepair.js";

const WRITE_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
  additionalProperties: false,
} as Record<string, unknown>;

describe("rung 1 — direct", () => {
  it("parses valid JSON untouched", () => {
    const out = repairToolArguments('{"a":1,"b":"two"}');
    expect(out.ok).toBe(true);
    expect(out.ok && out.args).toEqual({ a: 1, b: "two" });
    expect(out.ok && out.method).toBe("direct");
  });

  it("rejects a non-object (a bare array or scalar is not arguments)", () => {
    expect(repairToolArguments("[1,2,3]").ok).toBe(false);
    expect(repairToolArguments('"just a string"').ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(repairToolArguments("").ok).toBe(false);
    expect(repairToolArguments("   ").ok).toBe(false);
  });
});

describe("rung 2 — extraction", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["prose before", 'Here you go: {"a":1}', { a: 1 }],
    ["prose after", '{"a":1}\nHope that helps!', { a: 1 }],
    ["code fence", '```json\n{"a":1}\n```', { a: 1 }],
    ["both sides", 'Sure!\n```\n{"a":1}\n```\nDone.', { a: 1 }],
  ];

  for (const [name, raw, expected] of cases) {
    it(`extracts from ${name}`, () => {
      const out = repairToolArguments(raw);
      expect(out.ok).toBe(true);
      expect(out.ok && out.args).toEqual(expected);
      // The method reported is the one that SUCCEEDED. Extraction locates the
      // object and then parses it, so a successful extraction reports
      // "direct" — what matters is that the value came out right, not which
      // rung found it.
      expect(out.ok && ["direct", "extracted", "coerced"]).toContain(out.method);
    });
  }

  it("does NOT treat a brace inside a string as a nesting level", () => {
    const out = repairToolArguments('prefix {"note":"a } b","n":2} suffix');
    expect(out.ok && out.args).toEqual({ note: "a } b", n: 2 });
  });

  it("handles escaped quotes inside a value", () => {
    const out = repairToolArguments('{"note":"say \\"hi\\" }","n":1}');
    expect(out.ok && out.args).toEqual({ note: 'say "hi" }', n: 1 });
  });

  it("handles nesting", () => {
    const out = repairToolArguments('x {"a":{"b":[1,2,{"c":"}"}]}} y');
    expect(out.ok && out.args).toEqual({ a: { b: [1, 2, { c: "}" }] } });
  });
});

describe("rung 3 — coercion", () => {
  it("strips trailing commas", () => {
    const out = repairToolArguments('{"a":1,}');
    expect(out.ok && out.args).toEqual({ a: 1 });
  });

  it("quotes unquoted keys", () => {
    const out = repairToolArguments("{a:1}");
    expect(out.ok && out.args).toEqual({ a: 1 });
  });

  it("converts Python literals", () => {
    expect((repairToolArguments('{"a":None}').ok) && repairToolArguments('{"a":None}').args)
      .toEqual({ a: null });
    expect((repairToolArguments('{"a":True}').ok) && repairToolArguments('{"a":True}').args)
      .toEqual({ a: true });
    expect((repairToolArguments('{"a":False}').ok) && repairToolArguments('{"a":False}').args)
      .toEqual({ a: false });
  });

  it("leaves a comma INSIDE a string alone", () => {
    // A blanket trailing-comma regex corrupts this value. The correction must
    // not run inside string literals.
    const out = repairToolArguments('{"a":"x, } y","b":1,}');
    expect(out.ok && out.args).toEqual({ a: "x, } y", b: 1 });
  });

  it("leaves an apostrophe inside a value alone", () => {
    // The reason single-to-double quote conversion is NOT in the ladder: it
    // cannot be done safely, and doing it anyway corrupts data silently.
    const out = repairToolArguments('{"a":"it\'s fine"}');
    expect(out.ok && out.args).toEqual({ a: "it's fine" });
  });

  it("leaves a brace inside a string alone while coercing", () => {
    const out = coerce('{"a":"{not code}","b":None}');
    const parsed = repairToolArguments(out);
    expect(parsed.ok && parsed.args).toEqual({ a: "{not code}", b: null });
  });
});

describe("truncation", () => {
  it("closes a complete object missing only its punctuation", () => {
    // The case worth recovering: everything the tool needs is present and only
    // the closing brace is missing.
    const out = repairToolArguments('{"a":1,"b":2');
    expect(out.ok).toBe(true);
    expect(out.ok && out.args).toEqual({ a: 1, b: 2 });
  });

  it("closes a write_file cut off AFTER its last value closed", () => {
    // Recoverable: every value is complete, only the closing brace is gone.
    // The `content` ends with its own quote, so nothing has to be invented.
    const out = repairAndValidate('{"path":"/tmp/x.txt","content":"hello"', WRITE_SCHEMA);
    expect(out.ok).toBe(true);
    expect(out.ok && out.args).toEqual({ path: "/tmp/x.txt", content: "hello" });
  });

  it("REFUSES a write_file cut off INSIDE a string value", () => {
    // Unrecoverable, and deliberately so. Closing the string would mean
    // guessing where the model's text ended — for a write_file that is silent
    // data loss. The two truncation cases must not be conflated.
    const out = repairAndValidate('{"path":"/tmp/x.txt","content":"hello', WRITE_SCHEMA);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe("tool_call_unrepairable");
  });

  it("REFUSES a write_file whose content is cut off mid-value", () => {
    // The single most important test in the file. Closing this would produce a
    // write_file with a partial file body — silent data loss, and worse than
    // the empty-object behaviour this replaced.
    const out = repairAndValidate('{"path":"/tmp/x.txt","content":"half a fi', WRITE_SCHEMA);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe("tool_call_unrepairable");
  });

  it("refuses when a required field is simply missing", () => {
    const out = repairAndValidate('{"path":"/tmp/x.txt"', WRITE_SCHEMA);
    expect(out.ok).toBe(false);
  });

  it("refuses an unterminated string rather than fabricating its content", () => {
    // Direct assertion on closeTruncated. NOTE: this refusal is defended twice
    // over — the inString guard here, and the fact that tryDirect cannot parse
    // an unterminated string. Removing either one alone does not change the
    // result, so this test pins the CONTRACT (never fabricate a value) rather
    // than a single line. That redundancy is deliberate.
    expect(closeTruncated('{"a":"never closed')).toBeNull();
    expect(closeTruncated('{"a":"half')).toBeNull();
    // A string that is properly closed is a different case entirely.
    expect(closeTruncated('{"a":"done"')).not.toBeNull();
  });

  it("refuses a dangling key", () => {
    expect(closeTruncated('{"a":')).toBeNull();
  });
});

describe("schema validation", () => {
  const cases: Array<[string, unknown, string, RegExp]> = [
    ["missing required", { path: "/x" }, "content", /content/],
    ["wrong type", { path: "/x", content: 42 }, "content", /expected string/],
    ["additional property", { path: "/x", content: "y", extra: 1 }, "extra", /additional/],
  ];

  for (const [name, value, at, pattern] of cases) {
    it(`rejects ${name}`, () => {
      const out = repairAndValidate(value, WRITE_SCHEMA);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.detail).toMatch(pattern);
      expect(!out.ok && out.detail).toContain(at);
    });
  }

  it("accepts a valid call", () => {
    const out = repairAndValidate({ path: "/x", content: "y" }, WRITE_SCHEMA);
    expect(out.ok).toBe(true);
  });

  it("accepts {} when the schema has NO required properties", () => {
    // The legal empty case. A test asserting "never empty" would be wrong,
    // and would push a fix that breaks parameterless tools.
    const out = repairAndValidate({}, { type: "object", properties: {} });
    expect(out.ok).toBe(true);
  });

  it("rejects {} when the schema DOES require properties", () => {
    expect(repairAndValidate({}, WRITE_SCHEMA).ok).toBe(false);
  });

  it("validates nested paths", () => {
    const schema = { type: "object", properties: { opts: { type: "object" } }, required: ["opts"] };
    const issues = validateAgainstSchema({ opts: "not-an-object" }, schema);
    expect(issues.some((i) => i.path === "opts")).toBe(true);
  });

  it("passes anything when there is no schema", () => {
    expect(repairAndValidate({ any: "thing" }, undefined).ok).toBe(true);
  });
});

describe("value entry point", () => {
  it("passes an already-parsed object straight through", () => {
    const out = repairToolArgumentsValue({ a: 1 });
    expect(out.ok && out.method).toBe("object");
  });

  it("repairs a string", () => {
    const out = repairToolArgumentsValue('```\n{"a":1}\n```');
    expect(out.ok && out.args).toEqual({ a: 1 });
  });

  it("rejects null and non-strings", () => {
    expect(repairToolArgumentsValue(null).ok).toBe(false);
    expect(repairToolArgumentsValue(42).ok).toBe(false);
  });
});

describe("fuzz", () => {
  /**
   * Mutations of a VALID call. The property is NOT "always succeeds" — some
   * mutations are genuinely unrecoverable, and demanding success would force
   * a dangerous "fix". The property is: either a schema-valid object, or a
   * clean failure. Never a wrong object.
   */
  it("never produces a wrong object, only a valid one or a clean failure", () => {
    const base = '{"path":"/tmp/a.txt","content":"hello world","n":42}';
    let repaired = 0;
    let refused = 0;

    for (let cut = 0; cut < base.length; cut++) {
      const truncated = base.slice(0, cut);
      const out = repairAndValidate(truncated, WRITE_SCHEMA);
      if (out.ok) {
        repaired++;
        // If it claims success it must be a genuinely complete call.
        expect(typeof out.args["path"]).toBe("string");
        expect(typeof out.args["content"]).toBe("string");
        // And the content must not be a fabrication — it must be a prefix of
        // the original.
        expect(base).toContain(out.args["content"] as string);
      } else {
        refused++;
        expect(out.code).toBe("tool_call_unrepairable");
      }
    }

    // Truncation must produce a MIX: some recoverable, some refused. All-or-
    // nothing in either direction would mean the check is not doing anything.
    expect(repaired).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("survives injected prose, fences, and unicode", () => {
    const seeds = [
      '{"a":1}',
      '{"name":"emoji 🎉 done","v":[1,2,3]}',
      '{"s":"has } brace and , comma"}',
    ];
    const noise = ["", "```json\n", "\n```\n", "Here you go: ", "\n\nHope that helps!"];
    for (const seed of seeds) {
      for (const n1 of noise) {
        for (const n2 of noise) {
          const out = repairAndValidate(n1 + seed + n2, undefined);
          if (out.ok) {
            // Whatever came back must be an object, never a string or array.
            expect(typeof out.args).toBe("object");
            expect(Array.isArray(out.args)).toBe(false);
          }
        }
      }
    }
  });
});

describe("extractBalanced directly", () => {
  it("returns null when there is no object at all", () => {
    expect(extractBalanced("no braces here")).toBeNull();
    expect(extractBalanced("")).toBeNull();
  });

  it("returns the outer object, not an inner one", () => {
    expect(extractBalanced('{"a":{"b":1}}')).toBe('{"a":{"b":1}}');
  });
});
