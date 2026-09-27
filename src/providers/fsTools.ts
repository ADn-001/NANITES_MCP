/**
 * Nanites-internal filesystem tools for the CLOUD sub-agent tool loop
 *. LM Studio's own tool loop cannot extend to cloud providers — a
 * hosted model only *proposes* tool calls; nothing on the provider side can
 * touch local disk. Nanites therefore executes an allowlisted set of file
 * operations itself and re-injects the results as `role: "tool"` messages.
 *
 * Local (LM Studio) sub-agents are unaffected: they keep the external MCP
 * grant (`tools.integrations` of type plugin/ephemeral_mcp, executed by LM
 * Studio). These tools are the cloud counterpart — executed by Nanites in
 * this process, confined to a root directory (default: process.cwd()).
 *
 * Tool names intentionally mirror common filesystem-server naming so an
 * external HTTP filesystem MCP can later swap in behind the same surface.
 */
import { promises as fsp, realpathSync } from "node:fs";
import path from "node:path";
import type { ProviderToolDef } from "./types.js";

/** Tool names the cloud fs grant can allowlist. */
export const FS_TOOL_NAMES = [
  "read_file",
  "write_file",
  "list_directory",
  "search_files",
  "get_file_info",
] as const;
export type FsToolName = (typeof FS_TOOL_NAMES)[number];

/**
 * The read-only tool set: everything except write_file.
 *
 * write_file is deliberately not the default. A bare tools.fs: {} used to
 * hand a cloud sub-agent arbitrary write access to process.cwd() — the
 * source tree itself, and through it package.json, .git/hooks/* and
 * .claude/. Writing has to be asked for by name.
 */
const READ_ONLY_TOOL_NAMES: readonly FsToolName[] = FS_TOOL_NAMES.filter((n) => n !== "write_file");

/**
 * The tool names a grant actually permits. Fail-closed by construction.
 *
 * The previous code filtered the operator allowlist to known names and fell
 * back to ALL FIVE when that list came out empty, so a typo, a renamed tool,
 * or a name belonging to some other MCP server silently upgraded a
 * read-only grant to full read AND write access.
 *
 *   absent/null -> the read-only set
 *   []          -> nothing at all
 *   otherwise   -> exactly these, filtered to names that exist
 *
 * buildFsToolDefs and executeFsTool both call this, so the advertised set
 * and the enforced set cannot drift apart.
 */
export function resolveAllowedNames(grant: FsGrant | null | undefined): FsToolName[] {
  const raw = grant?.allowed_tools;
  if (raw == null) return [...READ_ONLY_TOOL_NAMES];
  if (raw.length === 0) return [];
  const known = new Set<string>(FS_TOOL_NAMES);
  return [...new Set(raw.filter((t): t is FsToolName => known.has(t)))];
}

export interface FsGrant {
  /** Root directory tools may touch. Defaults to process.cwd(). */
  root?: string | null;
  /**
   * Subset of FS_TOOL_NAMES to expose. absent/null = the read-only set
   * (everything except write_file); [] = nothing; otherwise exactly these,
   * filtered to names that exist.
   */
  allowed_tools?: string[] | null;
}

const MAX_READ_CHARS = 24_000;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 100;
/**
 * search_files runs a MODEL-SUPPLIED regex over file contents on the
 * single-threaded MCP event loop, so a pattern like (a+)+$ backtracks
 * catastrophically and wedges the whole server. The walk also had no depth
 * cap and no total-bytes budget, so a pattern matching nothing read every
 * file under the root.
 */
const MAX_PATTERN_CHARS = 200;
const MAX_WALK_DEPTH = 12;
const MAX_WALK_BYTES = 8 * 1024 * 1024;

/**
 * Resolve a caller-supplied path inside `root`. Absolute paths are accepted
 * only when they stay under root; anything escaping (via ".." or an absolute
 * path elsewhere on disk) is refused. Returns the joined absolute path or a
 * structured refusal — file tools never touch anything outside root.
 */
/**
 * Resolve the deepest existing ancestor of `p` with realpath.
 *
 * A lexical check cannot see a symlink or Windows junction *inside* the
 * root: a node_modules junction out of the tree passes a pure path.relative
 * test and then reads straight out of the sandbox. There was no realpath or
 * lstat anywhere in src/ before this.
 *
 * The target may not exist yet (write_file creates it), so on failure we
 * walk up to the nearest existing parent and resolve that instead.
 */
function realpathDeepest(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  }
}

/**
 * Resolve a caller-supplied path inside `root`.
 *
 * Lexical gate first (cheap, rejects the obvious escapes), then the real
 * check on realpath-resolved paths. The refusal message omits the root on
 * purpose: it is returned to the model verbatim and CLAUDE.md section 6
 * forbids absolute paths reaching the orchestrator.
 */
export function resolveWithinRoot(
  root: string,
  input: string,
): { ok: true; absPath: string } | { ok: false; error: string } {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "path must be a non-empty string" };
  }
  const abs = path.resolve(root, input);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "path escapes the tool root" };
  }
  const realRoot = realpathDeepest(path.resolve(root));
  const realAbs = realpathDeepest(abs);
  const realRel = path.relative(realRoot, realAbs);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    return { ok: false, error: "path escapes the tool root" };
  }
  return { ok: true, absPath: abs };
}

/** Relative display form of an absolute path under root (for tool output). */
function rel(root: string, abs: string): string {
  const r = path.relative(root, abs);
  return r === "" ? "." : r.replaceAll("\\", "/");
}

async function toolResult(root: string, abs: string, fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${rel(root, abs) ?? ""} ${msg}`;
  }
}

async function execReadFile(root: string, args: Record<string, unknown>): Promise<string> {
  const p = typeof args.path === "string" ? args.path : "";
  const resolved = resolveWithinRoot(root, p);
  if (!resolved.ok) return `error: ${resolved.error}`;
  return toolResult(root, resolved.absPath, async () => {
    const text = await fsp.readFile(resolved.absPath, "utf8");
    const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;
    const limit =
      typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, MAX_READ_CHARS) : MAX_READ_CHARS;
    const slice = text.slice(offset, offset + limit);
    const truncated = text.length > offset + limit;
    return `${rel(root, resolved.absPath)}\n${truncated ? "[truncated]\n" : ""}${slice}`;
  });
}

async function execWriteFile(root: string, args: Record<string, unknown>): Promise<string> {
  const p = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";
  const resolved = resolveWithinRoot(root, p);
  if (!resolved.ok) return `error: ${resolved.error}`;
  return toolResult(root, resolved.absPath, async () => {
    await fsp.writeFile(resolved.absPath, content, "utf8");
    return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel(root, resolved.absPath)}`;
  });
}

async function execListDirectory(root: string, args: Record<string, unknown>): Promise<string> {
  const p = typeof args.path === "string" ? args.path : ".";
  const resolved = resolveWithinRoot(root, p);
  if (!resolved.ok) return `error: ${resolved.error}`;
  return toolResult(root, resolved.absPath, async () => {
    const entries = await fsp.readdir(resolved.absPath, { withFileTypes: true });
    const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
      const suffix = e.isDirectory() ? "/" : "";
      return `${rel(root, path.join(resolved.absPath, e.name))}${suffix}`;
    });
    const extra = entries.length > MAX_LIST_ENTRIES ? `\n... ${entries.length - MAX_LIST_ENTRIES} more entries` : "";
    return lines.length ? lines.join("\n") + extra : "(empty)";
  });
}

async function execGetFileInfo(root: string, args: Record<string, unknown>): Promise<string> {
  const p = typeof args.path === "string" ? args.path : ".";
  const resolved = resolveWithinRoot(root, p);
  if (!resolved.ok) return `error: ${resolved.error}`;
  try {
    const st = await fsp.stat(resolved.absPath);
    return JSON.stringify({
      path: rel(root, resolved.absPath),
      exists: true,
      is_directory: st.isDirectory(),
      is_file: st.isFile(),
      size_bytes: st.size,
      modified_at: st.mtime.toISOString(),
    });
  } catch {
    return JSON.stringify({ path: rel(root, resolved.absPath), exists: false });
  }
}

async function execSearchFiles(root: string, args: Record<string, unknown>): Promise<string> {
  const p = typeof args.path === "string" && args.path ? args.path : ".";
  const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern : "";
  if (!pattern) return "error: pattern is required";
  let re: RegExp;
  try {
    if (pattern.length > MAX_PATTERN_CHARS) {
      return `error: pattern exceeds ${MAX_PATTERN_CHARS} characters`;
    }
    // Nested quantifiers are the classic ReDoS shape.
    if (/(?:[+*}][^)]*)[+*}]/.test(pattern)) {
      return "error: pattern contains a nested quantifier";
    }
    re = new RegExp(pattern);
  } catch (err) {
    return `error: invalid pattern: ${err instanceof Error ? err.message : String(err)}`;
  }
  const resolved = resolveWithinRoot(root, p);
  if (!resolved.ok) return `error: ${resolved.error}`;
  const matches: string[] = [];
  const seen = new Set<string>();
  const skip = new Set([".git", "node_modules", "dist", ".cache", ".scratch"]);
  let walkedBytes = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || walkedBytes >= MAX_WALK_BYTES) return;
    if (matches.length >= MAX_SEARCH_MATCHES) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (e.isFile()) {
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat || stat.size > 512 * 1024) continue; // skip binaries / huge files
        let text: string;
        try {
          walkedBytes += stat.size;
          text = await fsp.readFile(abs, "utf8");
        } catch {
          continue; // binary / undecodable
        }
        if (!seen.has(abs)) {
          seen.add(abs);
          if (re.test(text)) {
            matches.push(rel(root, abs));
          }
        }
      }
    }
  };
  await walk(resolved.absPath, 0);
  return matches.length ? matches.join("\n") : "(no matches)";
}

type Executor = (root: string, args: Record<string, unknown>) => Promise<string>;
/**
 * Null prototype so constructor, toString and __proto__ are not inherited
 * keys. The guard was `name in EXECUTORS`, which walks the prototype chain:
 * those names passed, were invoked unbound, and either threw a raw TypeError
 * into the tool loop or returned "[object Undefined]" to the model as a
 * successful result.
 */
const EXECUTORS: Record<FsToolName, Executor> = Object.assign(
  Object.create(null) as Record<FsToolName, Executor>,
  {
    read_file: execReadFile,
  write_file: execWriteFile,
  list_directory: execListDirectory,
  search_files: execSearchFiles,
    get_file_info: execGetFileInfo,
  },
);

const DEFS: Record<FsToolName, ProviderToolDef["function"]> = {
  read_file: {
    name: "read_file",
    description: "Read a UTF-8 text file under the tool root and return its contents (optionally a slice).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the tool root." },
        offset: { type: "integer", description: "Character offset to start reading from." },
        limit: { type: "integer", description: "Max characters to return (capped at 24000)." },
      },
      required: ["path"],
    },
  },
  write_file: {
    name: "write_file",
    description: "Write UTF-8 text to a file under the tool root (creates or overwrites).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the tool root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
  },
  list_directory: {
    name: "list_directory",
    description: "List entries in a directory under the tool root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (defaults to the tool root)." },
      },
    },
  },
  search_files: {
    name: "search_files",
    description: "Recursively search text files under the tool root for a regex pattern, returning matching file paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Directory to start from (defaults to the tool root)." },
      },
      required: ["pattern"],
    },
  },
  get_file_info: {
    name: "get_file_info",
    description: "Return metadata for a path under the tool root (existence, size, type).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to inspect, absolute or relative to the tool root." },
      },
      required: ["path"],
    },
  },
};

/** OpenAI tool definitions to advertise, filtered to the grant's allowlist. */
export function buildFsToolDefs(grant: FsGrant | null | undefined): ProviderToolDef[] {
  const rootGrant = grant ?? {};
  const names = resolveAllowedNames(rootGrant);
  return names.map((n) => ({ type: "function", function: DEFS[n] }));
}

/** Resolve the effective root for a grant (defaults to the process cwd). */
export function fsRoot(grant: FsGrant | null | undefined): string {
  return (grant?.root?.trim() || process.cwd());
}

/**
 * Execute a tool call the model issued. Returns the tool-result text Nanites
 * feeds back as a `role: "tool"` message. Refuses anything not in the grant's
 * allowlist and anything that escapes the root.
 */
export async function executeFsTool(
  grant: FsGrant | null | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  // Own-key only: `name in EXECUTORS` accepts prototype members.
  if (typeof name !== "string" || !Object.hasOwn(EXECUTORS, name)) {
    return { ok: false, output: `error: unknown tool "${String(name)}"` };
  }
  const allowedNames = resolveAllowedNames(grant);
  if (!allowedNames.includes(name as FsToolName)) {
    return { ok: false, output: `error: tool "${name}" is not in the allowed set` };
  }
  const output = await EXECUTORS[name as FsToolName](fsRoot(grant), args ?? {});
  return { ok: !output.startsWith("error:"), output };
}
