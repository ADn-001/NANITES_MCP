/**
 * Part B tool loop — external MCP wiring through run_sub_agent. Asserts that
 * when a profile's tool grant is enabled, the configured `integrations`
 * (MCP servers + allowlist) reach the LM Studio chat request; that tool calls
 * LM Studio executed come back as `tools_used`; and that the profile field
 * round-trips through the update_profile / get_active_profile tools. Tool
 * execution itself lives inside LM Studio — nanites attaches the
 * integrations and reports what ran; it does not spawn MCP clients.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSubAgentHarness, type SubAgentHarness } from "../phase8/helpers.js";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import type { ToolsConfig } from "../../src/storage/profileDefaults.js";
import type { ChatOutputItem } from "../../src/lmstudio/types.js";

const GEM = "gemma-3-270m-it-qat";

const PLUGIN_TOOLS: ToolsConfig = {
  enabled: true,
  integrations: [
    { type: "plugin", id: "mcp/filesystem", allowed_tools: ["read_file", "list_directory", "search_files"] },
    { type: "plugin", id: "mcp/command-runner", allowed_tools: ["run_process"] },
  ],
};

const EPHEMERAL_TOOLS: ToolsConfig = {
  enabled: true,
  integrations: [{ type: "ephemeral_mcp", server_label: "huggingface", server_url: "https://huggingface.co/mcp", allowed_tools: ["model_search"] }],
};

describe("run_sub_agent — tool grant attaches integrations to the wire", () => {
  let h: SubAgentHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("default profile sends no integrations (tools off)", async () => {
    h = await createSubAgentHarness({ registry: [{ model_id: GEM, roles: ["code_qa"], scores: { code_qa: 90 }, best_params: {}, last_tested: null }] });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(h.lastChat()!.integrations).toBeUndefined();
    expect(res.tools_used).toEqual([]);
  });

  it("enabled plugin integrations reach the chat request verbatim", async () => {
    h = await createSubAgentHarness({
      registry: [{ model_id: GEM, roles: ["code_qa"], scores: { code_qa: 90 }, best_params: {}, last_tested: null }],
      tools: PLUGIN_TOOLS,
    });
    await h.runAgent({ roles: ["code_qa"] });
    expect(h.lastChat()!.integrations).toEqual(PLUGIN_TOOLS.integrations);
  });

  it("enabled ephemeral integrations carry server_label + server_url + allowlist", async () => {
    h = await createSubAgentHarness({
      registry: [{ model_id: GEM, roles: ["code_qa"], scores: { code_qa: 90 }, best_params: {}, last_tested: null }],
      tools: EPHEMERAL_TOOLS,
    });
    await h.runAgent({ roles: ["code_qa"] });
    const integrations = h.lastChat()!.integrations as Array<Record<string, unknown>>;
    expect(integrations).toHaveLength(1);
    expect(integrations[0]!.type).toBe("ephemeral_mcp");
    expect(integrations[0]!.server_url).toBe("https://huggingface.co/mcp");
    expect(integrations[0]!.allowed_tools).toEqual(["model_search"]);
  });
});

describe("run_sub_agent — tool_call outputs surface as tools_used", () => {
  let h: SubAgentHarness;

  afterEach(async () => {
    await h?.close();
  });

  const base = () => ({ registry: [{ model_id: GEM, roles: ["code_qa"], scores: { code_qa: 90 }, best_params: {}, last_tested: null }], tools: PLUGIN_TOOLS });

  it("executed tool calls are reported, reply is the final message", async () => {
    const output: ChatOutputItem[] = [
      { type: "tool_call", tool: "read_file", arguments: { path: "package.json" }, output: '{"name":"nanites"}' },
      { type: "tool_call", tool: "list_directory", arguments: { path: "." }, output: "src, test" },
      { type: "message", content: "Read the manifest." },
    ];
    h = await createSubAgentHarness({ ...base(), toolOutputs: output });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.reply).toBe("Read the manifest.");
    expect(res.tools_used).toEqual([
      { tool: "read_file", output: '{"name":"nanites"}' },
      { tool: "list_directory", output: "src, test" },
    ]);
  });

  it("tool calls without output (refused/invalid) are not reported as executed", async () => {
    const output: ChatOutputItem[] = [
      { type: "tool_call", tool: "run_process", arguments: { command: "ls" } }, // no output — not executed
      { type: "invalid_tool_call", reason: "disallowed", metadata: {} },
      { type: "message", content: "Blocked." },
    ];
    h = await createSubAgentHarness({ ...base(), toolOutputs: output });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.tools_used).toEqual([]);
    expect(res.reply).toBe("Blocked.");
  });
});

describe("tools profile field — round-trip through profile tools", () => {
  let h: ToolHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("update_profile persists a tool grant; get_active_profile reflects it", async () => {
    h = await createHarness();
    const upd = await h.callTool("update_profile", { profile: "t", tools: PLUGIN_TOOLS });
    expect(upd.ok).toBe(true);
    const active = await h.callTool("get_active_profile", {});
    expect(active.ok).toBe(true);
    const profile = (active.data as { profile: { tools: ToolsConfig } }).profile;
    expect(profile.tools.enabled).toBe(true);
    expect(profile.tools.integrations).toEqual(PLUGIN_TOOLS.integrations);
  });

  it("malformed tools config is rejected by the schema", async () => {
    h = await createHarness();
    const raw = await h.callToolRaw("update_profile", {
      profile: "t",
      tools: { enabled: true, integrations: [{ type: "nope", id: "mcp/x" }] },
    });
    expect(raw.isError).toBe(true);
  });
});
