/**
 * Generate the PYTHON SOURCE the workers execute.
 *
 * A separate module, and a separate file from the worker itself, because the
 * generated code needs real newlines and real triple-quoted docstrings. Passing
 * that through a TypeScript template literal into `python -c` is how the first
 * helper shipped a silently broken program: a `__name__` emitted as a type
 * annotation produced an unparseable schema and a null result that took several
 * rounds of debugging to trace back to string escaping.
 *
 * Every interpolated value is passed through `pyLiteral` and `pyDoc`, so a tool
 * description containing a quote, a backslash, or a newline cannot terminate
 * the docstring early and change the generated program's meaning.
 */
/** A Python string literal, safe to embed anywhere in generated source. */
export function pyLiteral(value: string): string {
  // repr() of a str is already a valid Python literal, including for embedded
  // quotes, backslashes and newlines. JSON quoting is a close approximation for
  // the ASCII subset we emit, and Python and JSON agree on \n, \t, \" and \\.
  return JSON.stringify(String(value));
}

/**
 * A docstring body, safe to embed between triple quotes.
 *
 * A docstring cannot simply be repr'd when the value spans lines, and a naive
 * `"""..."""` wrap breaks on a value containing `"""` or a trailing backslash.
 * Both are escaped here rather than assumed absent.
 */
export function pyDoc(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, '\\"\\"\\"')
    .replace(/\r/g, "")
    // A docstring ending in a quote would otherwise close it early.
    .replace(/$/, (m) => (m ? "" : ""));
}

/** JSON Schema type name -> the type spelling a dataclass annotation needs. */
const TYPE_SPELLING: Record<string, string> = {
  string: "str",
  number: "float",
  integer: "int",
  boolean: "bool",
  array: "str",
  object: "str",
};

function spellingFor(schema: Record<string, unknown> | undefined): string {
  const t = schema?.["type"];
  if (typeof t === "string") return TYPE_SPELLING[t] ?? "str";
  // A union or an untyped property: str is the only spelling that never fails
  // to parse, and a wrong-shaped value is caught by the caller's validation.
  return "str";
}

const PY_TYPES = new Set(["str", "float", "int", "bool"]);

/**
 * Build a dataclass for a tool's argument schema.
 *
 * Only TOP-LEVEL scalar properties are emitted. A nested object or array would
 * need a real type, and Needle's extract path accepts a flat record; a nested
 * property becomes `str`, which is a lossy but VALID schema rather than an
 * unparseable one. The caller validates values, so a lossy schema degrades to a
 * rejected repair rather than a wrong one dispatched.
 */
export function schemaSourceFor(name: string, schema: Record<string, unknown>): string {
  const props = (schema["properties"] as Record<string, unknown> | undefined) ?? {};
  const required = new Set(
    Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).map(String) : [],
  );

  // Fields are sorted so the same schema always compiles to the same source.
  // The worker caches by source string; a stable order means a burst of calls
  // with the same tool hits the cache instead of recompiling.
  const fields = Object.keys(props).sort();
  const usable = fields.filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f));
  if (usable.length === 0) {
    throw new Error(`tool "${name}" has no usable scalar arguments to repair against`);
  }

  const lines: string[] = [
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    `class ${name}:`,
    `    """Arguments for the ${name} tool."""`,
  ];
  for (const field of usable) {
    const kind = spellingFor(props[field] as Record<string, unknown> | undefined);
    lines.push("");
    lines.push(`    ${field}: ${kind}`);
    const desc = (props[field] as Record<string, unknown> | undefined)?.["description"];
    lines.push(`    """${pyDoc(typeof desc === "string" && desc ? desc : `the ${field.replace(/_/g, " ")}`)}"""`);
  }
  lines.push("");
  lines.push(`SCHEMA = ${name}`);
  // Required-ness is informational for the caller, not enforced by the
  // dataclass: Needle fills what the text supports, and the router validates.
  lines.push(`REQUIRED = ${pyLiteral(JSON.stringify(required.size ? [...required].filter((f) => usable.includes(f)).sort() : []))}`);
  return lines.join("\n");
}

/** One tool as the router knows it. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * Build the tool set for a `complete()` call.
 *
 * EXTRACTION MODE, which is the shape the repair rung needs: a single tool
 * whose arguments are the record to fill. The model then has exactly one legal
 * output shape, and its `confidence` applies to that shape.
 */
export function singleToolSource(tool: ToolSpec): string {
  const schema = tool.parameters ?? {};
  return schemaSourceFor("Record", schema)
    .replace(
      "from dataclasses import dataclass",
      "import needle\nfrom dataclasses import dataclass",
    )
    .replace(
      `    """Arguments for the Record tool."""`,
      `    """${pyDoc(tool.description || `Reconstruct the arguments of the ${tool.name} call.`)}"""`,
    )
    .concat([
      "",
      "@needle.tool",
      "def record(",
      "    tool_name: str,",
      "    tool_arguments: str,",
      "):",
      `    """${pyDoc(tool.description || `Reconstruct the arguments of the ${tool.name} call.`)}"""`,
      "    raise NotImplementedError('the worker never executes tools')",
      "",
      "TOOLS = [record]",
      "",
    ].join("\n"));
}

/**
 * Build a MULTI-TOOL set, for picking which tool a turn needs.
 *
 * Each tool is a real function so Needle reports the WIRE name back, not the
 * Python symbol. Measured: handing Needle dataclasses makes it emit
 * `ReadFile` where the contract is `read_file`, which failed every comparison.
 */
export function multiToolSource(tools: ToolSpec[]): string {
  if (tools.length === 0) throw new Error("no tools to build");
  const parts: string[] = ["import needle", ""];
  const refs: string[] = [];
  for (const tool of tools) {
    const params = tool.parameters ?? {};
    const props = (params["properties"] as Record<string, unknown> | undefined) ?? {};
    const required = new Set(
      Array.isArray(params["required"]) ? (params["required"] as unknown[]).map(String) : [],
    );
    const names = Object.keys(props)
      .filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f))
      .sort();
    if (names.length === 0) {
      // A tool with no reconstructable arguments is REFUSED, not skipped.
      // Skipping it produced `TOOLS = []`, which the worker then answered as
      // an empty catalogue — so the model abstained and the caller read that
      // as a model decision rather than as its own malformed input.
      throw new Error(
        `tool "${tool.name}" has no reconstructable arguments; a repair needs at least one named parameter`,
      );
    }

    const sig = names
      .map((f) => {
        const kind = spellingFor(props[f] as Record<string, unknown> | undefined);
        return `${f}: ${kind}${required.has(f) ? "" : " = None"}`;
      })
      .join(", ");
    // The function is generated UNDER ITS WIRE NAME, so Needle reports that
    // name back. Naming the def after the symbol instead is what produced
    // `ReadFile` where the contract is `read_file`.
    parts.push(
      "@needle.tool",
      `def ${tool.name}(${sig}):`,
      `    """${pyDoc(tool.description || tool.name)}"""`,
      "    raise NotImplementedError('the worker never executes tools')",
      "",
    );
    refs.push(tool.name);
  }
  parts.push(`TOOLS = [${refs.join(", ")}]`, "");
  return parts.join("\n");
}
