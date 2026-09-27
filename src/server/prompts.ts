/**
 * The ten `/nanites-...` slash commands, wired as MCP prompts. Slash commands
 * are for deterministic script-chains only (per §1 of the project
 * instructions); anything inference-heavy lives in the companion SKILL.md.
 * Each prompt returns a single user message that names the exact tool chain to
 * run, in order, so the host orchestrator performs no judgment about *which*
 * tools to call — only argument plumbing.
 *
 * The first-run flow is the same prompt as `/nanites-new-profile`: the
 * get_first_run_status tool reports when zero profiles exist, and the skill
 * routes that state into this same chain (field-for-field by construction).
 */
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

type PromptArgs = Record<string, unknown>;

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

function registerPrompt<Args extends StandardSchemaWithJSON>(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  argsSchema: Args,
  body: (args: StandardSchemaWithJSON.InferOutput<Args>) => string,
): void {
  // Same collapse quirk as tools: with a generic schema the SDK callback type
  // resolves to the ctx-only form, so the wrapper is cast. Runtime contract is
  // stable — first argument is the validated args.
  server.registerPrompt(
    name,
    { title, description, argsSchema },
    ((args: StandardSchemaWithJSON.InferOutput<Args>) => userMessage(body(args))) as never,
  );
}

const newProfileArgs = z.object({
  name: z.string().min(1),
  machine_specs: z
    .object({
      cpu: z.string().optional(),
      gpu: z.string().optional(),
      vram_gb: z.number().optional(),
      ram_gb: z.number().optional(),
      storage: z.string().optional(),
    })
    .optional(),
  endpoint: z.object({ url: z.string().optional(), auth_token: z.string().nullable().optional() }).optional(),
  use_case: z.string().optional(),
  pricing: z
    .object({ input_per_million_usd: z.number().optional(), output_per_million_usd: z.number().optional() })
    .optional(),
  test_plan_ref: z.string().optional(),
  ntfy: z
    .object({ topic: z.string().nullable().optional(), server_url: z.string().optional(), access_token: z.string().nullable().optional() })
    .optional(),
  inference: z
    .object({
      effort: z.enum(["low", "medium", "high"]).optional(),
      output_token_ceiling: z.number().positive().optional(),
      system_prompt: z.string().nullable().optional(),
    })
    .optional(),
  dynamic_model: z.boolean().optional(),
});

export function registerNanitesPrompts(server: McpServer): void {
  registerPrompt(
    server,
    "nanites-new-profile",
    "Nanites New Profile",
    "Create a new profile from the user's stated fields and make it active. Pass every field the user supplied through unchanged; omit nothing they gave you.",
    newProfileArgs,
    (a) =>
      `Run the Nanites new-profile flow. Execute these tool calls in order, passing through the user's fields verbatim:

1. call \`create_profile\` with:
   - name = ${JSON.stringify(a.name)}
   - machine_specs = ${JSON.stringify(a.machine_specs ?? null)}
   - endpoint = ${JSON.stringify(a.endpoint ?? null)}
   - use_case = ${JSON.stringify(a.use_case ?? null)}
   - pricing = ${JSON.stringify(a.pricing ?? null)}
   - test_plan_ref = ${JSON.stringify(a.test_plan_ref ?? null)}
   - ntfy = ${JSON.stringify(a.ntfy ?? null)}
   - inference = ${JSON.stringify(a.inference ?? null)}
   - dynamic_model = ${JSON.stringify(a.dynamic_model ?? null)}

2. call \`switch_profile\` with name = ${JSON.stringify(a.name)} to make the new profile active.

3. call \`get_active_profile\` to confirm the profile is active before continuing.

Do not invent fields the user did not give you; create_profile applies documented defaults for anything omitted.`,
  );

  registerPrompt(
    server,
    "nanites-switch-profile",
    "Nanites Switch Profile",
    "Make a named profile the active one.",
    z.object({ name: z.string().min(1) }),
    (a) =>
      `Run the Nanites switch-profile flow. Execute these tool calls in order:

1. call \`switch_profile\` with name = ${JSON.stringify(a.name)}.

2. call \`get_active_profile\` to confirm the switch before continuing.`,
  );

  registerPrompt(
    server,
    "nanites-profiles",
    "Nanites List Profiles",
    "List the known profiles and which one is active.",
    z.object({}),
    () =>
      `Run the Nanites profiles flow. Execute these tool calls in order:

1. call \`list_profiles\`.

2. call \`get_active_profile\` to show which profile is active.`,
  );

  registerPrompt(
    server,
    "nanites-cost-saved",
    "Nanites Cost Saved Report",
    "Report tokens and estimated USD saved by local delegation for the active profile, over a period.",
    z.object({ period: z.enum(["all", "day", "week", "month"]).optional() }),
    (a) =>
      `Run the Nanites cost-saved report flow. Execute these tool calls in order:

1. call \`get_active_profile\` to resolve the active profile.

2. call \`get_cost_saved_report\` with profile = <the active profile's name> and period = ${JSON.stringify(a.period ?? "all")}.`,
  );

  registerPrompt(
    server,
    "nanites-effort",
    "Nanites Effort Level",
    "Set the active profile's effort level (low/medium/high) and optional output-token ceiling. Effort drives the inference planner's reasoning + token-budget decisions for every subsequent sub-agent call.",
    z.object({
      effort: z.enum(["low", "medium", "high"]),
      output_token_ceiling: z.number().positive().optional(),
    }),
    (a) =>
      `Run the Nanites effort-level flow. Execute these tool calls in order:

1. call \`get_active_profile\` to resolve the active profile name.

2. call \`update_profile\` (or \`create_profile\`'s settings path) with profile = <the active profile's name> and inference = ${JSON.stringify({ effort: a.effort, ...(a.output_token_ceiling !== undefined ? { output_token_ceiling: a.output_token_ceiling } : {}) })}.

3. call \`get_active_profile\` to confirm the effort took effect.`,
  );

  registerPrompt(
    server,
    "nanites-dynamic-model",
    "Nanites Dynamic Model Selection",
    "Toggle whether run_sub_agent hot-loads the best registry match for a role (on) or uses whatever models the user has loaded in LM Studio (off).",
    z.object({ mode: z.enum(["on", "off"]) }),
    (a) =>
      `Run the Nanites dynamic-model toggle. Execute these tool calls in order:

1. call \`get_active_profile\` to resolve the active profile name.

2. call \`update_profile\` with profile = <the active profile's name> and dynamic_model = ${a.mode === "on"}.

3. call \`get_active_profile\` to confirm the toggle took effect.`,
  );

  registerPrompt(
    server,
    "nanites-seed-agents",
    "Nanites Seed Cloudflare Agent Models",
    "Bulk-register the canonical Cloudflare agentic models (plus llama-3.2-11b-vision) for a profile: catalog registration with manifest capabilities, registry role-tagging, and default role pins. Idempotent.",
    z.object({
      profile: z.string().optional(),
      provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]).optional(),
      model_ids: z.array(z.string().min(1)).optional(),
    }),
    (a) =>
      `Run the Nanites seed-agents flow. Execute these tool calls in order:

1. call \`get_active_profile\` to resolve the active profile name (${JSON.stringify(a.profile ?? null)} overrides when given).

2. call \`seed_provider_models\` with:
   - profile = ${JSON.stringify(a.profile ?? null)} (omit to use the active profile)
   - provider = ${JSON.stringify(a.provider ?? null)} (omit for the Cloudflare default)
   - model_ids = ${JSON.stringify(a.model_ids ?? null)} (omit to seed the full manifest)

3. Report the registered model count, role-tagged registry entries, and which default pins were written (vs preserved because a custom pin already existed). An unknown model id is refused before anything is written.`,
  );

  registerPrompt(
    server,
    "nanites-pin",
    "Nanites Preferred-Model Pin",
    "List, set, or delete a preferred (provider, model) pin for a role on a profile. Pins auto-route sub-agent runs for that role; the fallback ladder takes over when the pinned target is unusable.",
    z.object({
      action: z.enum(["list", "set", "delete"]).default("list"),
      role: z.string().min(1).optional(),
      provider: z.enum(["local", "cloudflare", "openrouter", "omniroute", "generic"]).optional(),
      model_id: z.string().min(1).optional(),
    }),
    (a) =>
      `Run the Nanites role-pin flow. Execute these tool calls in order:

1. call \`get_active_profile\` to resolve the active profile name.

2. For action '${a.action}':
   - list: call \`list_role_pins\` with profile = <the active profile's name>.
   - set: call \`set_role_pin\` with profile = <the active profile's name>, role = ${JSON.stringify(a.role)}, provider = ${JSON.stringify(a.provider)}, and model_id = ${JSON.stringify(a.model_id)}.
   - delete: call \`delete_role_pin\` with profile = <the active profile's name> and role = ${JSON.stringify(a.role)}.

3. Report the resulting pin state (or the removed status). The role must be given for set/delete; 'local' provider means an LM Studio registry key.

Selection rules for a pin:
- A tool-using role must pin a TOOL-CAPABLE model. A pin to a model without function calling does not error — the run answers in prose with finish_reason 'stop' and the tools are silently ignored. Check the registry's capabilities before setting one.
- On Cloudflare, prefer a wide context for anything that runs a tool loop: the whole transcript is re-sent every round, so a 24k model is a poor reviewer however good it reads. The recommended Cloudflare reviewer is @cf/zai-org/glm-4.7-flash (131k, tool-capable).
- Reasoning models need the raised budget that effort medium/high produces. Under a low ceiling the thinking consumes the completion budget, content comes back empty, and finish_reason is 'length'.`,
  );

  registerPrompt(
    server,
    "nanites-vision",
    "Nanites Vision Capability Toggle",
    "Flip a profile's vision_capable flag. When off, the profile does no image work at all — delegation of image analysis to vision-capable models is disabled for it.",
    z.object({ mode: z.enum(["on", "off"]) }),
    (a) =>
      `Run the Nanites vision toggle. Execute these tool calls in order:

1. call \`get_active_profile\` to resolve the active profile name.

2. call \`update_profile\` with profile = <the active profile's name> and vision_capable = ${a.mode === "on"}.

3. call \`get_active_profile\` to confirm the flag took effect.

Note for image work that also uses tools: the routed model must be BOTH vision-capable and tool-capable (on Cloudflare, @cf/google/gemma-4-26b-a4b-it or @cf/qwen/qwen3.8-27b). @cf/meta/llama-3.2-11b-vision-instruct carries the vision role but is not tool-capable and is currently unreachable (HTTP 403, code 5016 — the Meta license agreement is not accepted on the account).`,
  );

  registerPrompt(
    server,
    "nanites-btw",
    "Nanites Working-Memory Chat",
    "Compact this session's context into a /nanites-btw working-memory chat for a profile and open it in the dashboard chat mode (btw-spec-v2 §5). One new active chat per profile; the previous chat's visible transcript is reset but the compaction caches persist.",
    z.object({ profile: z.string().min(1).optional(), initial_question: z.string().optional() }),
    (a) =>
      `Run the /nanites-btw working-memory flow. Execute these tool calls in order:

1. call \`get_active_profile\` to resolve the active profile name (${JSON.stringify(a.profile ?? null)} overrides when given).

2. call \`start_btw_chat\` with:
   - profile = ${JSON.stringify(a.profile ?? null)} (omit to use the active profile)
   - messages = the current session transcript as role/content pairs — the full conversation you and the user have had in this session so far (system/user/assistant turns, each message's actual content, not a summary)
   - initial_question = ${JSON.stringify(a.initial_question ?? null)} (the user's question to the compacted session, or omit)

3. The result returns a \`deep_link_url\` and a \`status\`. Open \`deep_link_url\` in the preview pane — the dashboard enters its /nanites-btw chat mode, maximizes, and (when an initial_question was given) shows the answer there once the held model finishes. If \`status\` is \`processing\`, the chat keeps working in the background; tell the user the chat is open and warming up. Never fabricate an answer the tool did not return inline.`,
  );
}
