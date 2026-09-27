/**
 * Declared mapping between the MCP prompt surface (`registerNanitesPrompts`),
 * the registered tool surface (`registerAllTools`), and the human-facing
 * `/nanites-...` command sheets under `plugin/nanites/commands/*.md`.
 *
 * The sweep (D8) found the command sheets are 13 prose guidance documents (9
 * paired with a registered prompt, 4 sheetless), NOT generated copies of the
 * prompt bodies — so they must not be auto-generated, but their drift must be
 * caught. This manifest is the single declared source
 * of truth the Phase-F drift guard checks against reality on disk:
 *
 *  1. Every command sheet file is declared here (no undocumented sheet, no
 *     dangling entry) and carries its expected `argument-hint`.
 *  2. Every registered MCP prompt is either paired with a sheet or declared
 *     sheetless (`PROMPT_ONLY_SHEETLESS`).
 *  3. Every tool a sheet tells the caller to run resolves to a registered tool.
 *  4. A paired sheet's first step matches its prompt's first tool call, so a
 *     sheet cannot silently drop the resolution step (the cost-saved bug: the
 *     report tool needs the active profile resolved first).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandSheet {
  /** plugin/nanites/commands/<command>.md, without the extension. */
  command: string;
  /** Registered MCP prompt this sheet documents, when one exists. */
  prompt: string | null;
  /** Expected frontmatter `argument-hint`, so the arg surface can't drift from
   * the tool's enum (e.g. the old cost-saved `[7d|30d|all]` vs the report
   * tool's `all|day|week|month`). */
  argumentHint: string;
}

/** The sheets that ship in plugin/nanites/commands. Single source of truth for
 * the drift guard: reality = the files on disk; a mismatch is a problem. */
export const COMMAND_SHEETS: CommandSheet[] = [
  { command: "nanites-cost-saved", prompt: "nanites-cost-saved", argumentHint: "[all|day|week|month]" },
  { command: "nanites-dynamic-model", prompt: "nanites-dynamic-model", argumentHint: "[on|off]" },
  { command: "nanites-effort", prompt: "nanites-effort", argumentHint: "[low|medium|high]" },
  { command: "nanites-health", prompt: null, argumentHint: "" },
  { command: "nanites-models", prompt: null, argumentHint: "" },
  { command: "nanites-new-profile", prompt: "nanites-new-profile", argumentHint: "[profile name] [vram_gb] [use_case]" },
  { command: "nanites-profiles", prompt: "nanites-profiles", argumentHint: "" },
  { command: "nanites-registry", prompt: null, argumentHint: "[model_id]" },
  { command: "nanites-untested", prompt: null, argumentHint: "[run]" },
  { command: "nanites-btw", prompt: "nanites-btw", argumentHint: "[profile name] [initial question]" },
  { command: "nanites-seed-agents", prompt: "nanites-seed-agents", argumentHint: "" },
  { command: "nanites-pin", prompt: "nanites-pin", argumentHint: "[list|set|delete] [role] [provider] [model_id]" },
  { command: "nanites-vision", prompt: "nanites-vision", argumentHint: "[on|off]" },
];

/** Registered prompts with no companion sheet (bare script-chains the
 * orchestrator runs; not every prompt deserves a human sheet, and forcing a
 * 1:1 would just paper over reality). */
export const PROMPT_ONLY_SHEETLESS: string[] = ["nanites-switch-profile"];

export const commandsManifestPrompts = (): string[] => [
  ...COMMAND_SHEETS.flatMap((s) => (s.prompt ? [s.prompt] : [])),
  ...PROMPT_ONLY_SHEETLESS,
];

export const declaredCommands = (): string[] => COMMAND_SHEETS.map((s) => s.command);

/**
 * Tool mentions a sheet tells the caller to invoke: backticked snake identifiers
 * directly after a `call ...` directive (plus a trailing `and \`x\`` chain).
 * The lookbehind excludes "per-call `effort`"-style prose — a directive, not a
 * mention of the token that happens to follow the word "call".
 */
export function toolMentions(md: string): string[] {
  const out: string[] = [];
  // The identifier class must accept uppercase: 12 provider tools are
  // registered in camelCase (`nanites_addProviderKey`), and an all-lowercase
  // class silently skipped every one of them.
  const re = /(?<![\w-])call\s+`([A-Za-z_][A-Za-z0-9_]*)`(?:\s+and\s+`([A-Za-z_][A-Za-z0-9_]*)`)?/gi;
  for (const m of md.matchAll(re)) {
    if (m[1]) out.push(m[1]);
    if (m[2]) out.push(m[2]);
  }
  return out;
}

/** Frontmatter `argument-hint` of a command sheet ("" when absent). */
export function sheetArgumentHint(md: string): string {
  return md.match(/^argument-hint:\s*"([^"]*)"/m)?.[1] ?? "";
}

/** Registered prompt names, parsed from prompts.ts register sites. */
export function registeredPromptNames(promptsSource: string): string[] {
  return [...promptsSource.matchAll(/registerPrompt\(\s*server,\s*"([a-z-]+)"/g)].map((m) => m[1]!);
}

/**
 * First tool each registered prompt names, parsed from prompts.ts source
 * (`registerPrompt(server, "<name>"` … then the body's first `call \`tool\``).
 * Reading source (not invoking the MCP layer) keeps the guard dependency-free.
 */
export function promptFirstTool(promptsSource: string): Map<string, string> {
  const map = new Map<string, string>();
  const names = [...promptsSource.matchAll(/registerPrompt\(\s*server,\s*"([a-z-]+)"/g)];
  for (let i = 0; i < names.length; i++) {
    const name = names[i]![1]!;
    const start = names[i]!.index;
    const end = i + 1 < names.length ? names[i + 1]!.index : promptsSource.length;
    const body = promptsSource.slice(start, end);
    const first = body.match(/call \\`([A-Za-z_][A-Za-z0-9_]*)`/i)?.[1] ?? undefined;
    if (first) map.set(name, first);
  }
  return map;
}

/** Registered tool names, parsed from the register sites (toolkit's §2 tools +
 * the server's `nanites_ping` liveness probe). */
export function registeredToolNames(...registerSources: string[]): Set<string> {
  const tools = new Set<string>();
  for (const src of registerSources) {
    // Uppercase is required: the provider tools register as camelCase
    // (`register(server, deps, "nanites_addProviderKey", …)`), which a
    // lowercase-only class silently drops — leaving the guard blind to them.
    for (const m of src.matchAll(/server, deps, "([A-Za-z_][A-Za-z0-9_]*)"/g)) tools.add(m[1]!);
    for (const m of src.matchAll(/registerTool\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) tools.add(m[1]!);
  }
  return tools;
}

export interface SurfaceReportInput {
  /** Command base names actually on disk (plugin/nanites/commands, no .md). */
  diskCommands: string[];
  /** Registered MCP prompt names. */
  registeredPrompts: string[];
  /** Registered tool names. */
  registeredTools: Set<string>;
  /** command base -> sheet markdown text. */
  sheetText: Map<string, string>;
  /** prompt name -> its first declared tool call. */
  promptFirstTool: Map<string, string>;
}

/** Pure drift check. Returns a human-readable problem per violation; empty
 * means the declared surface matches reality. Deterministic, no I/O — the
 * repo-backed wrapper below feeds it, and tests seed synthetic inputs. */
export function surfaceProblems(input: SurfaceReportInput): string[] {
  const problems: string[] = [];
  const declared = new Set(declaredCommands());
  const disk = new Set(input.diskCommands);

  for (const c of input.diskCommands) if (!declared.has(c)) problems.push(`undocumented command sheet: ${c} (add to COMMAND_SHEETS)`);
  for (const c of declaredCommands()) if (!disk.has(c)) problems.push(`declared command sheet missing on disk: ${c}`);

  const promptsDeclared = new Set(commandsManifestPrompts());
  for (const p of input.registeredPrompts) if (!promptsDeclared.has(p)) problems.push(`registered prompt has no manifest entry (sheet or sheetless): ${p}`);
  for (const p of promptsDeclared) if (!input.registeredPrompts.includes(p)) problems.push(`manifest prompt is not registered: ${p}`);

  for (const sheet of COMMAND_SHEETS) {
    const md = input.sheetText.get(sheet.command) ?? "";
    if (!md) {
      problems.push(`no markdown for sheet ${sheet.command}`);
      continue;
    }
    const hint = sheetArgumentHint(md);
    if (hint !== sheet.argumentHint) {
      problems.push(`${sheet.command}: argument-hint "${hint}" != declared "${sheet.argumentHint}"`);
    }
    const mentions = toolMentions(md);
    for (const tool of mentions) {
      if (!input.registeredTools.has(tool)) problems.push(`${sheet.command}: names unregistered tool \`${tool}\``);
    }
    if (sheet.prompt) {
      const promptTool = input.promptFirstTool.get(sheet.prompt);
      if (promptTool && mentions.length > 0 && mentions[0] !== promptTool) {
        problems.push(`${sheet.command}: first step \`${mentions[0]}\` != its prompt's first tool \`${promptTool}\``);
      }
    }
  }
  return problems;
}

/** Repo location the manifest + sheets live in (works from src or dist). */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const COMMANDS_DIR = path.join("plugin", "nanites", "commands");
const PROMPTS_SRC = path.join("src", "server", "prompts.ts");
const TOOLKIT_SRC = path.join("src", "tools", "toolkit.ts");
const BUILD_SRC = path.join("src", "server", "buildServer.ts");

/** Repo-backed check: loads the real files and reports any surface drift. */
export function checkNanitesSurface(root: string = repoRoot()): string[] {
  const dir = path.join(root, COMMANDS_DIR);
  const diskCommands = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));

  const sheetText = new Map<string, string>();
  for (const c of diskCommands) {
    sheetText.set(c, readFileSync(path.join(dir, `${c}.md`), "utf8"));
  }
  // A declared sheet that somehow has no file still needs an entry so the
  // "no markdown" branch reports it.
  for (const c of declaredCommands()) {
    if (!sheetText.has(c)) sheetText.set(c, "");
  }

  const promptsSource = readFileSync(path.join(root, PROMPTS_SRC), "utf8");
  const registeredPrompts = registeredPromptNames(promptsSource);
  const promptFirstToolMap = promptFirstTool(promptsSource);

  const toolkitSource = readFileSync(path.join(root, TOOLKIT_SRC), "utf8");
  const buildSource = readFileSync(path.join(root, BUILD_SRC), "utf8");
  const tools = registeredToolNames(toolkitSource, buildSource);

  return surfaceProblems({ diskCommands, registeredPrompts, registeredTools: tools, sheetText, promptFirstTool: promptFirstToolMap });
}
