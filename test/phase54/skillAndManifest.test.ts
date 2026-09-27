/**
 * Phase 54 gate — skill, command, and documentation layer.
 *
 * Two things are asserted here, both about the *surface* rather than the
 * inference path:
 *
 * 1. The declared surface matches reality — the Phase-F drift guard is blind to
 *    camelCase tool names unless its identifier class accepts uppercase, and a
 *    guard that silently skips 12 registered provider tools is worse than no
 *    guard at all. The skill's slash commands, the tool count published in
 *    docs/landscape, and the generated `.claude` skill copy are checked against
 *    the same source of truth.
 * 2. The concurrency leak is closed. A throw between the pool
 *    acquisition and a path's own guarded scope used to strand a slot and the
 *    sequential inference gate — and the throw in question (`vision_with_tool_
 *    loop`) lives on the cloud branch this sprint is about, so the leak would
 *    deadlock exactly the profile it was meant to serve.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { SubAgentPool } from "../../src/workflows/subAgentPool.js";
import { runSubAgent } from "../../src/workflows/runSubAgent.js";
import { acquireInferenceSlot, resetInferenceGates } from "../../src/helpers/inferenceGate.js";
import {
  checkNanitesSurface,
  declaredCommands,
  registeredToolNames,
  repoRoot,
  surfaceProblems,
  toolMentions,
} from "../../src/server/commandsManifest.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const GEM = "@cf/google/gemma-4-26b-a4b-it";
const homes: ToolDeps[] = [];
const scratchDirs: string[] = [];

function harness(profileName: string, opts?: { toolsEnabled?: boolean; root?: string }): { d: ToolDeps; profileName: string } {
  const home = scratchHome();
  scratchDirs.push(home);
  const d = buildDeps(home);
  homes.push(d);
  d.profiles.createProfile({
    name: profileName,
    ...(opts?.toolsEnabled
      ? { tools: { enabled: true, integrations: [], fs: { root: opts.root ?? process.cwd() } } }
      : {}),
  });
  d.profiles.switchProfile(profileName);
  return { d, profileName };
}

function addKey(d: ToolDeps, profile: string, provider: string): void {
  new ProviderKeyStore(d.db).addKey(profile, provider as never, `sk-test-${profile}-${Math.random().toString(36).slice(2)}`);
}

function addVisionModel(d: ToolDeps, profile: string, provider: string, modelId: string): void {
  new ProviderModelStore(d.db).registerManifestModel(profile, provider as never, {
    model_id: modelId,
    context_length: null,
    vision: true,
    function_calling: true,
  });
}

afterAll(() => {
  for (const d of homes) d.close();
  cleanup(...scratchDirs);
  resetInferenceGates();
});

describe("Phase 54 — drift guard sees the real tool surface", () => {
  it("the live surface has no drift problems", () => {
    expect(checkNanitesSurface()).toEqual([]);
  });

  it("a camelCase tool named by a sheet is visible to the guard", () => {
    // The regression: an all-lowercase identifier class silently skipped every
    // camelCase provider tool, so a sheet could name a nonexistent one and the
    // guard reported nothing.
    expect(toolMentions("call `nanites_addProviderKey` and `nanites_listProviderKeys`")).toEqual([
      "nanites_addProviderKey",
      "nanites_listProviderKeys",
    ]);

    const problems = surfaceProblems({
      diskCommands: declaredCommands(),
      registeredPrompts: [],
      registeredTools: new Set<string>(), // simulate a guard that missed them
      sheetText: new Map([["nanites-registry", 'call `nanites_addProviderKey`']]),
      promptFirstTool: new Map(),
    });
    expect(problems.some((p) => p.includes("nanites_addProviderKey"))).toBe(true);
  });

  it("the README publishes the registered tool count", () => {
    const root = repoRoot();
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    // The README's tool-reference section is the only doc a consumer reads, so
    // the drift guard watches it instead of an internal landscape note.
    const published = readme.match(/the real (\d+)-tool surface/)?.[1];
    expect(published).toBeDefined();

    const tools = registeredToolNames(
      readFileSync(path.join(root, "src", "tools", "toolkit.ts"), "utf8"),
      readFileSync(path.join(root, "src", "server", "buildServer.ts"), "utf8"),
    );
    expect(tools.size).toBe(Number(published));
    expect(tools.has("nanites_addProviderKey")).toBe(true);
  });
});

describe("Phase 54 — skill surface", () => {
  it("every slash command the skill names is a declared command", () => {
    const skill = readFileSync(path.join(repoRoot(), "plugin", "nanites", "skills", "nanites", "SKILL.md"), "utf8");
    const mentioned = new Set((skill.match(/\/nanites-[a-z-]+[a-z]/g) ?? []).map((s) => s.slice(1)));
    expect(mentioned.size).toBeGreaterThan(0);
    const declared = new Set(declaredCommands());
    expect([...mentioned].filter((c) => !declared.has(c))).toEqual([]);
  });

  it("npm run build's skill copy step produces a byte-identical .claude copy", () => {
    const root = repoRoot();
    execFileSync(process.execPath, [path.join(root, "scripts", "copy-skill.mjs")], { cwd: root });
    const canonical = readFileSync(path.join(root, "plugin", "nanites", "skills", "nanites", "SKILL.md"), "utf8");
    const generated = readFileSync(path.join(root, ".claude", "skills", "nanites", "SKILL.md"), "utf8");
    expect(generated).toBe(canonical);
    expect(generated.startsWith("---\n")).toBe(true);
  });
});

describe("Phase 54 — inference-gate acquisition leak", () => {
  it("a throw in the cloud pre-body releases the pool slot and the inference gate", async () => {
    const { d, profileName } = harness("p54-leak", { toolsEnabled: true, root: process.cwd() });
    addKey(d, profileName, "cloudflare");
    addVisionModel(d, profileName, "cloudflare", GEM);

    const pool = new SubAgentPool(1);
    let code: string | undefined;
    try {
      await runSubAgent(d, profileName, "describe", {
        images: ["data:image/png;base64,QUJD"],
        pool,
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }

    // The images + fs-grant combination is refused after acquisition — that is
    // what makes it the leak's worst case.
    expect(code).toBe("vision_with_tool_loop");
    expect(pool.activeCount).toBe(0);

    // A stranded gate never resolves; a released one hands over immediately.
    const raced = await Promise.race([
      acquireInferenceSlot(profileName),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500)),
    ]);
    expect(raced).not.toBe("timeout");
    if (typeof raced === "function") raced();
  });
});
