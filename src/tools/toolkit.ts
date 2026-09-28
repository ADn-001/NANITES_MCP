/**
 * The full §2 MCP tool surface. Every tool: schema-validated in, structured
 * error out. Model/inference tools resolve their endpoint from the active
 * profile; the six workflow/notification tools are surface-only until their
 * phase lands, returning a structured `not_available` error rather than a
 * half-working handler.
 */
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ToolDeps } from "./deps.js";
import { clientForProfile, requireActiveProfile, resolveAuthToken } from "./deps.js";
import { planOpen, type UiPlanConfig } from "../ui/openSession.js";
import type { DashboardHandle } from "../ui/lifecycle.js";
import { endpointFingerprint } from "../helpers/endpointFingerprint.js";
import { guard } from "./responses.js";
import { NanitesError } from "../helpers/errors.js";
import { cleanReply } from "../helpers/cleaner.js";
import { providerPreferenceOrderSchema, type Profile } from "../storage/profileDefaults.js";
import { outboundUrlSchema } from "../ui/guards.js";
import { concurrencyLoadExtras } from "../helpers/concurrency.js";
import { allowedPairsForVram } from "../guardrails/tiers.js";
import { stalenessFor } from "../helpers/staleness.js";
import { sampleLiveFreeVram } from "../helpers/liveVram.js";
import { validateTestUnit } from "../testunits/validator.js";
import type { TestUnit } from "../testunits/schema.js";
import type { ChatInput, ChatOutputItem, ModelInfo } from "../lmstudio/types.js";
import type { RegistryEntry } from "../storage/registryStore.js";
import type { CreateProfileInput } from "../storage/profileDefaults.js";
import { runHealthCheck, defaultDiskDir } from "../health/checker.js";
import { sendNtfy } from "../notify/ntfy.js";
import { fireProfilePush } from "../notify/profileNotifier.js";
import { runTestRegimen } from "../workflows/runTestRegimen.js";
import { getPendingJudgments } from "../workflows/getPendingJudgments.js";
import { submitTestJudgment } from "../workflows/submitTestJudgment.js";
import { runSubAgent } from "../workflows/runSubAgent.js";
import { backfillScores } from "../workflows/backfillScores.js";
import { BUILT_IN_ROLES } from "../workflows/roleMatch.js";
import { startSubAgentJob, getSubAgentJobStatus } from "../workflows/jobRunner.js";
import { startBtwChat } from "../workflows/startBtwChat.js";
import { filterByGuardrail, type ModelCandidate } from "../workflows/guardrailFilter.js";
import { findUntestedModels } from "../workflows/untested.js";
import { downloadAndWait } from "../workflows/downloadAndWait.js";
import { downloadAndTest } from "../workflows/downloadAndTest.js";
import { runUntestedSweep } from "../workflows/runUntestedSweep.js";
import { getCostSavedReport } from "../workflows/costSavedReport.js";
import { checkAdaptation, registerAdaptedUnits } from "../workflows/adaptation.js";
import {
  addProviderKey,
  removeProviderKey,
  listProviderKeys,
  toggleProviderKey,
  discoverProviderModels,
  listProviderModels,
  registerProviderModel,
  deregisterProviderModel,
  showProviderErrors,
  setProviderEnabled,
  getProviderConfig,
  setProviderPreferenceOrder,
} from "./providers.js";
import {
  seedProviderModels,
  setRolePin,
  listRolePins,
  deleteRolePin,
} from "../workflows/seedProviderModels.js";

type ToolHandler<Args> = (deps: ToolDeps, args: Args) => unknown | Promise<unknown>;

/** Runtime-only dashboard controller (see buildServer `uiController`). */
export interface UiController {
  start(): Promise<DashboardHandle>;
}

// Which tools carry a dashboard_url, at which view, and whether every call must
// reload (mutations). Run/read tools open once per kind per process; mutations
// open + reload every call so the page refetches and SSE rebinds to the profile.
const UI_PLAN: Record<string, UiPlanConfig> = {
  run_sub_agent: { view: "live" },
  run_test_regimen: { view: "live" },
  run_untested_sweep: { view: "live" },
  download_and_test: { view: "live" },
  download_and_wait: { view: "live" },
  read_registry: { view: "registry" },
  list_test_units: { view: "registry" },
  validate_test_unit: { view: "registry" },
  diff_untested: { view: "registry" },
  get_pending_judgments: { view: "registry" },
  check_adaptation: { view: "registry" },
  filter_by_guardrail: { view: "registry" },
  write_registry_entry: { view: "registry", mutation: true },
  register_test_unit: { view: "registry", mutation: true },
  register_adapted_units: { view: "registry", mutation: true },
  submit_test_judgment: { view: "registry", mutation: true },
  share_test_results: { view: "registry", mutation: true },
  list_models: { view: "hardware" },
  get_loaded_model: { view: "hardware" },
  get_download_status: { view: "hardware" },
  load_model: { view: "hardware", mutation: true },
  unload_model: { view: "hardware", mutation: true },
  get_cost_saved_report: { view: "cost" },
  system_health_check: { view: "health" },
  create_profile: { view: "settings", mutation: true },
  switch_profile: { view: "settings", mutation: true },
  update_profile: { view: "settings", mutation: true },
  list_profiles: { view: "settings" },
  // online providers
  nanites_addProviderKey: { view: "providers", mutation: true },
  nanites_removeProviderKey: { view: "providers", mutation: true },
  nanites_toggleProviderKey: { view: "providers", mutation: true },
  nanites_discoverProviderModels: { view: "providers", mutation: true },
  nanites_registerProviderModel: { view: "providers", mutation: true },
  nanites_deregisterProviderModel: { view: "providers", mutation: true },
  nanites_listProviderModels: { view: "providers" },
  nanites_listProviderKeys: { view: "providers" },
  nanites_showProviderErrors: { view: "providers" },
  nanites_setProviderEnabled: { view: "providers", mutation: true },
  nanites_getProviderConfig: { view: "providers" },
  nanites_setProviderPreferenceOrder: { view: "providers", mutation: true },
  seed_provider_models: { view: "providers", mutation: true },
  set_role_pin: { view: "providers", mutation: true },
  list_role_pins: { view: "providers" },
  delete_role_pin: { view: "providers", mutation: true },
};

let activeUiController: UiController | null = null;

async function decorateForUi(name: string, result: unknown): Promise<unknown> {
  if (!activeUiController || result === null || typeof result !== "object") return result;
  const cfg = UI_PLAN[name];
  if (!cfg) return result;
  const plan = planOpen(name, cfg);
  if (!plan.navigate || !plan.url) return result;
  const handle = await activeUiController.start();
  // The MCP never starts the dashboard itself; opening the returned
  // dashboard_url in the embedded preview starts it (attach binds the port).
  // So decorate whenever orchestration is enabled — even if nothing is serving
  // yet. Only NANITES_AUTOSTART_UI=0 suppresses the decoration.
  if (!handle.enabled) return result;
  return {
    ...(result as Record<string, unknown>),
    dashboard_url: plan.url,
    dashboard_action: plan.reload ? "navigate+reload" : "navigate",
  };
}

function register<Schema extends StandardSchemaWithJSON>(
  server: McpServer,
  deps: ToolDeps,
  name: string,
  title: string,
  description: string,
  schema: Schema,
  handler: ToolHandler<StandardSchemaWithJSON.InferOutput<Schema>>,
): void {
  // The SDK's callback type only resolves the args-form for a concrete (non-generic)
  // inputSchema; with a generic schema it collapses to the ctx-only form, and its
  // result types are cross-bundle-branded so a structurally identical return won't
  // satisfy it. The runtime contract is stable — the first argument is the validated
  // args — so we cast the wrapper and keep our own handler typing precise.
  server.registerTool(
    name,
    { title, description, inputSchema: schema },
    (async (args: StandardSchemaWithJSON.InferOutput<Schema>) => {
      // Run the handler + decorate INSIDE the guard so a handler throw still
      // becomes the structured { ok:false, error } envelope.
      return guard(async () => {
        const raw = await handler(deps, args);
        try {
          return await decorateForUi(name, raw);
        } catch {
          return raw; // a UI-start failure never fails the tool
        }
      });
    }) as never,
  );
}

function notAvailable(message: string): ToolHandler<unknown> {
  return () => {
    throw new NanitesError({ code: "not_available", message, retryable: false });
  };
}

const ID = z.string().min(1);
const VERBOSE = { verbose: z.boolean().optional() };

// ---- schemas ----
const listModelsSchema = z.object(VERBOSE);
const getLoadedModelSchema = z.object(VERBOSE);
const loadModelSchema = z.object({
  model_id: ID,
  params: z
    .object({
      context_length: z.number().positive().optional(),
      eval_batch_size: z.number().positive().optional(),
      flash_attention: z.boolean().optional(),
      num_experts: z.number().int().nonnegative().optional(),
      offload_kv_cache_to_gpu: z.boolean().optional(),
      echo_load_config: z.boolean().optional(),
      /** Concurrent-prompt slots; validated against the active tier's allowed set. */
      num_parallel: z.number().int().positive().optional(),
    })
    .optional(),
});
const unloadModelSchema = z.object({ instance_id: ID });
const chatSchema = z.object({
  instance_id: ID,
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
    .min(1),
  params: z
    .object({
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      top_k: z.number().optional(),
      min_p: z.number().optional(),
      repeat_penalty: z.number().optional(),
      max_output_tokens: z.number().positive().optional(),
      reasoning: z.enum(["off", "low", "medium", "high", "on"]).optional(),
      context_length: z.number().positive().optional(),
    })
    .optional(),
  timeout_s: z.number().positive().optional(),
});
const downloadModelSchema = z.object({ source: ID, quantization: z.string().optional() });
const getDownloadStatusSchema = z.object({ job_id: ID });

const readRegistrySchema = z.object({ profile: ID, model_id: ID.optional(), ...VERBOSE });
const writeRegistryEntrySchema = z.object({
  profile: ID,
  model_id: ID,
  entry: z.object({
    provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]).nullable().optional(),
    roles: z.array(z.string()).optional(),
    scores: z.record(z.string(), z.number()).optional(),
    score_minima: z.record(z.string(), z.number()).optional(),
    best_params: z.record(z.string(), z.unknown()).optional(),
    last_tested: z.string().optional(),
  }),
});
const shareTestResultsSchema = z.object({ profile: ID, source_profile: ID, model_id: ID.optional() });

const toolIntegrationSchema = z.union([
  z.object({
    type: z.literal("plugin"),
    id: z.string(),
    allowed_tools: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("ephemeral_mcp"),
    server_label: z.string(),
    server_url: z.string(),
    allowed_tools: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
const fsGrantInputSchema = z.object({
  root: z.string().nullable().optional(),
  allowed_tools: z.array(z.string()).nullable().optional(),
});
const toolsConfigSchema = z.object({
  enabled: z.boolean(),
  integrations: z.array(toolIntegrationSchema),
  fs: fsGrantInputSchema.nullable().optional(),
});

/** Concurrency override pair; null clears an existing override back to the tier default. Validated against the effective tier in resolveProfile. */
const concurrencyOverrideInputSchema = z
  .object({
    max_parallel_models: z.number().int().positive(),
    num_parallel: z.number().int().positive(),
  })
  .nullable()
  .optional();

const createProfileSchema = z.object({
  name: ID,
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
  pricing: z.object({ input_per_million_usd: z.number().optional(), output_per_million_usd: z.number().optional() }).optional(),
  test_plan_ref: z.string().optional(),
  ntfy: z
    .object({ topic: z.string().nullable().optional(), server_url: z.string().optional(), access_token: z.string().nullable().optional() })
    .optional(),
  inference: z
    .object({
      effort: z.enum(["low", "medium", "high"]).optional(),
      output_token_ceiling: z.number().positive().optional(),
      system_prompt: z.string().nullable().optional(),
      ttl_s: z.number().int().min(0).max(3600).optional(),
    })
    .optional(),
  dynamic_model: z.boolean().optional(),
  vision_capable: z.boolean().optional(),
  tools: toolsConfigSchema.optional(),
  concurrency_override: concurrencyOverrideInputSchema,
});
const switchProfileSchema = z.object({ name: ID });
const listProfilesSchema = z.object(VERBOSE);
const getActiveProfileSchema = z.object({});

// Partial profile patch for update_profile — accepts any subset, type-checks
// the ones it gets (same contract as the dashboard's POST /api/settings/profile).
const updateProfileSchema = z.object({
  profile: ID,
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
  pricing: z.object({ input_per_million_usd: z.number().optional(), output_per_million_usd: z.number().optional() }).optional(),
  test_plan_ref: z.string().nullable().optional(),
  ntfy: z
    .object({ topic: z.string().nullable().optional(), server_url: z.string().optional(), access_token: z.string().nullable().optional() })
    .optional(),
  inference: z
    .object({
      effort: z.enum(["low", "medium", "high"]).optional(),
      output_token_ceiling: z.number().positive().optional(),
      system_prompt: z.string().nullable().optional(),
      ttl_s: z.number().int().min(0).max(3600).optional(),
    })
    .optional(),
  dynamic_model: z.boolean().optional(),
  vision_capable: z.boolean().optional(),
  tools: toolsConfigSchema.optional(),
  concurrency_override: concurrencyOverrideInputSchema,
});

const firstRunStatusSchema = z.object({});

const listTestUnitsSchema = z.object({ profile: ID });
const validateTestUnitSchema = z.object({ unit: z.record(z.string(), z.unknown()) });
const registerTestUnitSchema = z.object({ profile: ID, unit: z.record(z.string(), z.unknown()) });

// Phase 7 workflow tools — surface-only until run_test_regimen lands.
// `provider` routes the regimen through a cloud provider
// instead of LM Studio; the tested model_id is then a provider model id.
const runTestRegimenSchema = z.object({
  profile: ID,
  model_id: ID,
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]).optional(),
});
const getPendingJudgmentsSchema = z.object({ profile: ID, model_id: ID, unit_ids: z.array(ID).optional() });
const submitTestJudgmentSchema = z.object({
  profile: ID,
  model_id: ID,
  unit_id: ID,
  score: z.number().min(0).max(100),
  orchestrator_notes: z.string(),
  user_approved: z.boolean(),
  user_notes: z.string().optional(),
});

// Phase 8 sub-agent. The orchestrator picks role + model + writes the brief;
// the inference planner owns reasoning + output budget + context + generation
// timeout from the profile's effort. Optional per-call `effort`
// overrides the profile default; reasoning/max_output_tokens were removed in
// favor of the planner.

/**
 * Structured output. Capped: a schema is a contract, not a payload
 * channel — an oversized one becomes prompt the model must read on every round.
 */
const outputSchemaField = z
  .record(z.string(), z.unknown())
  .refine((s) => JSON.stringify(s).length <= 8_000, { message: "output_schema is larger than 8000 characters" })
  .optional();
const outputSchemaNameField = z.string().min(1).optional();

const runSubAgentSchema = z
  .object({
    profile: ID,
    brief: z.string().min(1),
    roles: z.array(z.string().min(1)).optional(),
    model_id: ID.optional(),
    /** Cloud provider to route through instead of local LM Studio. */
    provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]).optional(),
    task: z.string().optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    system_prompt_override: z.string().optional(),
    reasoning_budget: z.number().positive().optional(),
    /** Vision input: local path, http(s) URL, or data: URI per element. Cloud-only
     * and tool-less — a local or fs-loop run with images is rejected. */
    images: z.array(z.string().min(1)).optional(),
    /** JSON Schema the answer must conform to. Cloud-only; a non-conforming
     * answer is reported in `validation.issues`, never silently accepted. */
    output_schema: outputSchemaField,
    output_schema_name: outputSchemaNameField,
  })
  .strict(); // reject stale reasoning/max_output_tokens — the planner owns them now

// Phase C async jobs — same validated inputs as run_sub_agent, minus the
// blocking call. start_* returns a job id immediately; poll with
// get_*_job_status. Job-mode only: a queued job whose profile is at its
// concurrency tier waits FIFO instead of erroring concurrency_limit.
const startSubAgentJobSchema = z
  .object({
    profile: ID,
    brief: z.string().min(1),
    roles: z.array(z.string().min(1)).optional(),
    model_id: ID.optional(),
    provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]).optional(),
    task: z.string().optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    output_schema: outputSchemaField,
    output_schema_name: outputSchemaNameField,
  })
  .strict();
const getSubAgentJobStatusSchema = z.object({ job_id: z.number().int().positive() });

// Phase H `/nanites-btw` (btw-spec-v2 §4.1). The only Claude-facing tool the
// feature adds; chat continuation happens over the dashboard's own HTTP
// endpoints (§8). `max_token_threshold` is intentionally NOT accepted — the
// output ceiling lives on the profile (inference.output_token_ceiling), so a
// stale per-call threshold is rejected like run_sub_agent's removed params.
const startBtwChatSchema = z
  .object({
    profile: ID.optional(),
    messages: z.array(z.object({ role: z.string().min(1), content: z.string() })).optional(),
    initial_question: z.string().optional(),
  })
  .strict();

// Phase 9 workflows #3/#4.
const diffUntestedSchema = z.object({ profile: ID, ...VERBOSE });
const runUntestedSweepSchema = z.object({ profile: ID });
const downloadAndWaitSchema = z.object({ profile: ID, source: ID, quantization: z.string().optional() });
const downloadAndTestSchema = z.object({ profile: ID, source: ID, quantization: z.string().optional() });
const filterByGuardrailSchema = z.object({
  profile: ID,
  candidates: z
    .array(
      z.object({
        model: ID,
        params: z.string().nullable().optional(),
        size_bytes: z.number().optional(),
      }),
    )
    .min(1),
});

// Phase 10 cost report + adaptation.
const getCostSavedReportSchema = z.object({ profile: ID, period: z.enum(["all", "day", "week", "month"]).optional() });
const checkAdaptationSchema = z.object({ profile: ID });

// ---- Phase 1 online providers ----
const addProviderKeySchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
  api_key: z.string(),
  account_id: z.string().optional(),
  // Validated: this URL decides where the provider API key is sent.
  gateway_url: outboundUrlSchema.optional(),
  // A user-facing label. This is what makes several endpoints on one provider
  // distinguishable — `generic` in particular holds many OpenAI-compatible
  // gateways, and without a name there is no way to tell them apart in the list
  // or on the board. The store has always persisted it; only this tool failed
  // to accept it.
  nickname: z.string().optional(),
});
const removeProviderKeySchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
  key_id: ID,
});
const listProviderKeysSchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
});
const toggleProviderKeySchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
  key_id: ID,
  enabled: z.boolean(),
});
const discoverProviderModelsSchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
});
const listProviderModelsSchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
  registered_only: z.boolean().optional(),
});
const registerProviderModelSchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
  model_id: ID,
});
const deregisterProviderModelSchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]),
  model_id: ID,
});
const PIN_PROVIDER_ENUM = ["local", "cloudflare", "openrouter", "omniroute", "generic"] as const;
const seedProviderModelsSchema = z.object({
  profile: ID.optional(),
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic"]).optional(),
  model_ids: z.array(ID).optional(),
});
const setRolePinSchema = z.object({
  profile: ID.optional(),
  role: ID,
  provider: z.enum(PIN_PROVIDER_ENUM),
  model_id: ID,
});
const listRolePinsSchema = z.object({ profile: ID.optional() });
const deleteRolePinSchema = z.object({ profile: ID.optional(), role: ID });
const showProviderErrorsSchema = z.object({ filter: z.string().optional() });
const setProviderEnabledSchema = z.object({
  provider: z.enum(["cloudflare", "openrouter", "omniroute", "generic", "local"]),
  enabled: z.boolean(),
});
const getProviderConfigSchema = z.object({});
const setProviderPreferenceOrderSchema = z.object({
  order: providerPreferenceOrderSchema,
});
const registerAdaptedUnitsSchema = z.object({ profile: ID, units: z.array(z.record(z.string(), z.unknown())).min(1) });

// Phase 6 health + notifications.
const systemHealthCheckSchema = z.object({ profile: ID });
const sendNtfySchema = z.object({ profile: ID, message: z.string(), tags: z.array(z.string()).optional() });

// ---- handlers ----
/** The role names a registry entry may use for a profile: the built-in roles
 * (eleven, incl. `vision`) plus any role seen on its registered test units
 * (custom units add roles — never hard-close, E5-side). */
function roleVocabulary(deps: ToolDeps, profile: string): Set<string> {
  const roles = new Set(BUILT_IN_ROLES);
  for (const unit of deps.testUnits.list(profile)) {
    for (const role of unit.applicable_roles) roles.add(role);
  }
  return roles;
}

function trimModel(m: ModelInfo) {
  return {
    model: m.key,
    type: m.type,
    params_string: m.params_string,
    quantization: m.quantization?.name ?? null,
    size_bytes: m.size_bytes,
    loaded_instance_ids: m.loaded_instances.map((i) => i.id),
    max_context_length: m.max_context_length,
  };
}

function modelsPayload(models: ModelInfo[], verbose?: boolean) {
  return { models: verbose ? models : models.map(trimModel) };
}

async function handleListModels(deps: ToolDeps, args: z.infer<typeof listModelsSchema>) {
  const client = clientForProfile(requireActiveProfile(deps));
  const { models } = await client.listModels();
  return modelsPayload(models, args.verbose);
}

async function handleGetLoadedModel(deps: ToolDeps, args: z.infer<typeof getLoadedModelSchema>) {
  const client = clientForProfile(requireActiveProfile(deps));
  const loaded = await client.getLoadedModel();
  return modelsPayload(loaded, args.verbose);
}

async function handleLoadModel(deps: ToolDeps, args: z.infer<typeof loadModelSchema>) {
  const profile = requireActiveProfile(deps);
  const client = clientForProfile(profile);
  const requested = args.params?.num_parallel;
  // Manual loads default to the active profile's tier pair; an explicit
  // num_parallel is advisory-validated against the tier's allowed slots
  // (forced sequential tiers allow only 1).
  const slots = requested ?? profile.concurrency?.num_parallel ?? 1;
  if (requested !== undefined) {
    const allowedSlots = allowedPairsForVram(profile.machine_specs.vram_gb).map((p) => p.num_parallel);
    const slotSet = allowedSlots.length > 0 ? allowedSlots : [1];
    if (!slotSet.includes(requested)) {
      throw new NanitesError({
        code: "concurrency_override_invalid",
        message: `num_parallel=${requested} is not allowed on this profile's tier (vram_gb=${profile.machine_specs.vram_gb}; allowed slots: ${slotSet.join(", ")})`,
        retryable: false,
      });
    }
  }
  const rest = { ...(args.params ?? {}) };
  delete rest.num_parallel;
  return client.loadModel({ model: args.model_id, ...rest, ...concurrencyLoadExtras(slots) });
}

async function handleUnloadModel(deps: ToolDeps, args: z.infer<typeof unloadModelSchema>) {
  const client = clientForProfile(requireActiveProfile(deps));
  return client.unloadModel({ instance_id: args.instance_id });
}

async function handleChat(deps: ToolDeps, args: z.infer<typeof chatSchema>) {
  const profile = requireActiveProfile(deps);
  const client = clientForProfile(
    profile,
    args.timeout_s !== undefined ? { timeoutMs: Math.round(args.timeout_s * 1000) } : undefined,
  );

  const system =
    args.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;
  const rest = args.messages.filter((m) => m.role !== "system");
  const input: ChatInput =
    rest.length === 0 ? "" : rest.length === 1 ? rest[0]!.content : rest.map((m) => ({ type: "text", content: m.content }));

  const { response } = await client.chat(args.instance_id, input, { ...args.params, system_prompt: system });

  const messageTexts: string[] = [];
  const otherOutputs: ChatOutputItem[] = [];
  for (const item of response.output) {
    if (item.type === "message") messageTexts.push(item.content);
    else otherOutputs.push(item);
  }

  const clean = cleanReply(messageTexts.join("\n"), { maxChars: 100_000 });
  const issues = [...clean.issues];
  if (otherOutputs.length > 0) issues.push("non_text_output_present");
  return {
    model_instance_id: response.model_instance_id,
    reply: clean.text,
    stats: response.stats,
    validation: { cleaned: clean.cleaned || otherOutputs.length > 0, issues },
  };
}

async function handleDownloadModel(deps: ToolDeps, args: z.infer<typeof downloadModelSchema>) {
  const client = clientForProfile(requireActiveProfile(deps));
  return client.downloadModel({ model: args.source, ...(args.quantization !== undefined ? { quantization: args.quantization } : {}) });
}

async function handleGetDownloadStatus(deps: ToolDeps, args: z.infer<typeof getDownloadStatusSchema>) {
  const client = clientForProfile(requireActiveProfile(deps));
  return client.getDownloadStatus(args.job_id);
}

function handleReadRegistry(deps: ToolDeps, args: z.infer<typeof readRegistrySchema>) {
  // E5 lazy backfill: a read that spots a malformed (legacy unit-keyed,
  // hand-inserted, or minima-less) entry heals it in place, so legacy entries
  // converge on role-keyed scores + score_minima. Idempotent and no-op when
  // nothing is malformed, keeping the common read path read-only.
  backfillScores(deps, args.profile, roleVocabulary(deps, args.profile));
  // A single-model read takes only an id, which no longer identifies a row on
  // its own now that provider is part of the key. getAny() prefers the local
  // row and falls back to whichever provider row exists, so a cloud model is
  // still readable by its bare id.
  const entries = args.model_id
    ? (() => { const e = deps.registry.getAny(args.profile, args.model_id); return e ? [e] : []; })()
    : deps.registry.list(args.profile);
  return {
    entries: entries.map((e) => {
      if (args.verbose) return e;
      // G1: informational staleness signal on the trimmed surface — a note, never
      // an auto re-test.
      const staleness = stalenessFor(e.last_tested);
      return { ...staleness, model_id: e.model_id, roles: e.roles, scores: e.scores, best_params: e.best_params, last_tested: e.last_tested };
    }),
  };
}

function handleWriteRegistryEntry(deps: ToolDeps, args: z.infer<typeof writeRegistryEntrySchema>) {
  // Same reasoning as the read path: the write names a model by id, so it must
  // find that model's existing row wherever it lives, and carry its provider
  // forward so a cloud entry is not silently re-tagged local.
  const existing = deps.registry.getAny(args.profile, args.model_id);

  // E5-side validation against the profile's role vocabulary (built-in roles +
  // registered test-unit roles). Rejects unit-id keys, unknown role keys, and
  // out-of-range values so the role-keyed aggregation cannot be re-broken by
  // the one write path that bypasses finalize.
  const vocab = roleVocabulary(deps, args.profile);
  const merged = { ...existing, ...args.entry } as Partial<RegistryEntry>;
  const roles = merged.roles ?? [];
  const outScores = merged.scores ?? {};
  const issues: string[] = [];

  for (const role of roles) {
    if (!vocab.has(role)) issues.push(`roles: "${role}" is not a role for this profile`);
  }
  for (const [key, value] of Object.entries(outScores)) {
    if (!vocab.has(key)) issues.push(`scores: unknown role/unit key "${key}"`);
    if (typeof value !== "number" || value < 0 || value > 100) {
      issues.push(`scores: "${key}" must be a number in 0-100`);
    }
  }
  const givenMinima = merged.score_minima;
  if (givenMinima !== undefined) {
    for (const [key, value] of Object.entries(givenMinima)) {
      if (!vocab.has(key)) issues.push(`score_minima: unknown role key "${key}"`);
      if (typeof value !== "number" || value < 0 || value > 100) {
        issues.push(`score_minima: "${key}" must be a number in 0-100`);
      }
    }
  }
  if (issues.length > 0) {
    throw new NanitesError({ code: "registry_entry_invalid", message: issues.join("; "), retryable: false, details: { issues } });
  }

  // A role-keyed write without an explicit score_minima defaults to a
  // single-sample floor (min == the recorded score) so the entry never reads
  // as unbacked by the E3 low-confidence check.
  const outMinima = givenMinima ?? (Object.keys(outScores).length > 0 ? { ...outScores } : undefined);

  deps.registry.upsert(args.profile, {
    model_id: args.model_id,
    provider: args.entry.provider ?? existing?.provider ?? null,
    roles,
    scores: outScores,
    ...(outMinima !== undefined ? { score_minima: outMinima } : {}),
    best_params: merged.best_params ?? {},
    last_tested: merged.last_tested ?? existing?.last_tested ?? null,
    ...(existing ? { performance_score: existing.performance_score, avg_load_ms: existing.avg_load_ms, avg_response_ms: existing.avg_response_ms, reasoning_type: existing.reasoning_type } : {}),
  });
  return deps.registry.getAny(args.profile, args.model_id);
}

/**
 * G2 cross-profile share. Opt-in only: copy a source profile's approved
 * test_results into this profile when both point at the same LM Studio instance
 * (endpoint fingerprint). Isolation stays the default — different endpoints (or
 * a different auth presence) are refused, never silently merged.
 */
function handleShareTestResults(deps: ToolDeps, args: z.infer<typeof shareTestResultsSchema>) {
  if (args.profile === args.source_profile) {
    throw new NanitesError({
      code: "share_self",
      message: `source_profile must differ from profile ("${args.profile}" given) — there is nothing to share with yourself`,
      retryable: false,
    });
  }
  const target = deps.profiles.getProfile(args.profile);
  if (!target) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
  }
  const source = deps.profiles.getProfile(args.source_profile);
  if (!source) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.source_profile}"`, retryable: false });
  }
  const fpTarget = endpointFingerprint(
    target.endpoint.url,
    resolveAuthToken(target.endpoint.auth_token, process.env.NANITES_LMS_API_TOKEN) != null,
  );
  const fpSource = endpointFingerprint(
    source.endpoint.url,
    resolveAuthToken(source.endpoint.auth_token, process.env.NANITES_LMS_API_TOKEN) != null,
  );
  if (fpTarget !== fpSource) {
    throw new NanitesError({
      code: "endpoint_mismatch",
      message:
        `profiles "${args.profile}" and "${args.source_profile}" do not share an endpoint ` +
        `(fingerprint ${fpTarget} != ${fpSource}) — test results are isolated per instance; nothing was copied`,
      retryable: false,
    });
  }
  const { copied, skipped } = deps.testResults.copyApprovedResults(args.source_profile, args.profile, args.model_id);
  return {
    endpoint_fingerprint: fpTarget,
    source_profile: args.source_profile,
    copied,
    skipped,
    note:
      "approved test results copied into this profile; nothing was auto-finalized in its registry — " +
      "a later regimen/finalize aggregates them without re-running the model",
  };
}

function handleCreateProfile(deps: ToolDeps, args: z.infer<typeof createProfileSchema>) {
  return maskProfile(deps.profiles.createProfile(args));
}

function handleSwitchProfile(deps: ToolDeps, args: z.infer<typeof switchProfileSchema>) {
  return maskProfile(deps.profiles.switchProfile(args.name));
}

function handleUpdateProfile(deps: ToolDeps, args: z.infer<typeof updateProfileSchema>) {
  const { profile, ...patch } = args;
  return maskProfile(deps.profiles.updateProfile(profile, patch as CreateProfileInput));
}

function handleListProfiles(deps: ToolDeps, args: z.infer<typeof listProfilesSchema>) {
  const names = deps.profiles.listProfiles();
  if (args.verbose) {
    return { profiles: names.map((n) => maskProfile(deps.profiles.getProfile(n)!)).filter(Boolean) };
  }
  return { profiles: names };
}

function maskProfile(profile: Profile | null): Profile | null {
  if (!profile) return null;
  return {
    ...profile,
    endpoint: { url: profile.endpoint.url, auth_token: null },
    ntfy: { ...profile.ntfy, access_token: null },
  };
}

function handleGetActiveProfile(deps: ToolDeps) {
  return { profile: maskProfile(deps.profiles.getActiveProfile()) };
}

function handleFirstRunStatus(deps: ToolDeps) {
  const profileCount = deps.profiles.listProfiles().length;
  return { needs_first_run: profileCount === 0, profile_count: profileCount };
}

function handleListTestUnits(deps: ToolDeps, args: z.infer<typeof listTestUnitsSchema>) {
  return { units: deps.testUnits.list(args.profile) };
}

function handleValidateTestUnit(_deps: ToolDeps, args: z.infer<typeof validateTestUnitSchema>) {
  return validateTestUnit(args.unit);
}

function handleRegisterTestUnit(deps: ToolDeps, args: z.infer<typeof registerTestUnitSchema>) {
  const stored = deps.testUnits.register(args.profile, args.unit);
  return { unit: stored };
}

async function handleSystemHealthCheck(deps: ToolDeps, args: z.infer<typeof systemHealthCheckSchema>) {
  const profile = deps.profiles.getProfile(args.profile);
  if (!profile) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
  }
  const report = await runHealthCheck({
    profile: args.profile,
    client: clientForProfile(profile, { timeoutMs: 5_000 }),
    // G3: live-VRAM-aware tier advisory. The sampler returns null on builds with
    // no VRAM surface -> static tier + recorded note, never a fabricated number.
    hardware: { vram_gb: profile.machine_specs.vram_gb, live_free_vram_gb: (await sampleLiveFreeVram()).free_vram_gb },
    // Measured on the models volume, never the ambient system disk, so the
    // healthy/degraded verdict does not depend on which drive the host is low
    // on. `deps.healthDisk` lets a test pin the reading outright.
    disk: deps.healthDisk ?? { dir: defaultDiskDir() },
  });
  if (report.overall === "down") {
    void fireProfilePush(profile, "health_down", {
      profile: args.profile,
      code: "health_check_failed",
      reason: report.reason,
    });
  }
  return report;
}

async function handleSendNtfy(deps: ToolDeps, args: z.infer<typeof sendNtfySchema>) {
  const profile = deps.profiles.getProfile(args.profile);
  if (!profile) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
  }
  return sendNtfy(profile.ntfy, args.message, args.tags);
}

function handleRunTestRegimen(deps: ToolDeps, args: z.infer<typeof runTestRegimenSchema>) {
  return runTestRegimen(deps, args.profile, args.model_id, args.provider ? { provider: args.provider } : {});
}

function handleGetPendingJudgments(deps: ToolDeps, args: z.infer<typeof getPendingJudgmentsSchema>) {
  return getPendingJudgments(deps, args.profile, args.model_id, args.unit_ids);
}

function handleSubmitTestJudgment(deps: ToolDeps, args: z.infer<typeof submitTestJudgmentSchema>) {
  return submitTestJudgment(deps, {
    profile: args.profile,
    model_id: args.model_id,
    unit_id: args.unit_id,
    score: args.score,
    orchestrator_notes: args.orchestrator_notes,
    user_approved: args.user_approved,
    user_notes: args.user_notes,
  });
}

function handleRunSubAgent(deps: ToolDeps, args: z.infer<typeof runSubAgentSchema>) {
  return runSubAgent(deps, args.profile, args.brief, {
    roles: args.roles,
    model_id: args.model_id,
    provider: args.provider,
    task: args.task,
    effort: args.effort,
    system_prompt_override: args.system_prompt_override,
    reasoning_budget: args.reasoning_budget,
    images: args.images,
    outputSchema: args.output_schema,
    outputSchemaName: args.output_schema_name,
  });
}

function handleStartSubAgentJob(deps: ToolDeps, args: z.infer<typeof startSubAgentJobSchema>) {
  const job_id = startSubAgentJob(deps, args);
  return { job_id };
}

function handleGetSubAgentJobStatus(deps: ToolDeps, args: z.infer<typeof getSubAgentJobStatusSchema>) {
  return getSubAgentJobStatus(deps, args.job_id);
}

async function handleStartBtwChat(deps: ToolDeps, args: z.infer<typeof startBtwChatSchema>) {
  return startBtwChat(deps, args);
}

async function handleDiffUntested(deps: ToolDeps, args: z.infer<typeof diffUntestedSchema>) {
  const profile = deps.profiles.getProfile(args.profile);
  if (!profile) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
  }
  const { models } = await clientForProfile(profile).listModels();
  const untested = findUntestedModels(models, deps.registry.list(args.profile));
  return {
    untested_count: untested.length,
    models: untested.map((m) => ({
      model: m.key,
      params_string: m.params_string,
      quantization: m.quantization?.name ?? null,
      size_bytes: m.size_bytes,
    })),
  };
}

function handleRunUntestedSweep(deps: ToolDeps, args: z.infer<typeof runUntestedSweepSchema>) {
  return runUntestedSweep(deps, args.profile);
}

function handleDownloadAndWait(deps: ToolDeps, args: z.infer<typeof downloadAndWaitSchema>) {
  return downloadAndWait(deps, args.profile, args.source, args.quantization ? { quantization: args.quantization } : {});
}

function handleDownloadAndTest(deps: ToolDeps, args: z.infer<typeof downloadAndTestSchema>) {
  return downloadAndTest(deps, args.profile, args.source, args.quantization ? { quantization: args.quantization } : {});
}

function handleFilterByGuardrail(deps: ToolDeps, args: z.infer<typeof filterByGuardrailSchema>) {
  const profile = deps.profiles.getProfile(args.profile);
  if (!profile) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
  }
  return filterByGuardrail(args.candidates as ModelCandidate[], profile.machine_specs.vram_gb);
}

function handleGetCostSavedReport(deps: ToolDeps, args: z.infer<typeof getCostSavedReportSchema>) {
  return getCostSavedReport(deps, args.profile, args.period ? { period: args.period } : {});
}

function handleCheckAdaptation(deps: ToolDeps, args: z.infer<typeof checkAdaptationSchema>) {
  const profile = deps.profiles.getProfile(args.profile);
  if (!profile) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
  }
  return checkAdaptation(profile.use_case);
}

function handleRegisterAdaptedUnits(deps: ToolDeps, args: z.infer<typeof registerAdaptedUnitsSchema>) {
  return registerAdaptedUnits(deps, args.profile, args.units as unknown as TestUnit[]);
}

// ---- Phase 1 online providers ----
function handleAddProviderKey(deps: ToolDeps, args: z.infer<typeof addProviderKeySchema>) {
  return addProviderKey(deps, args.provider, args.api_key, {
    accountId: args.account_id,
    gatewayUrl: args.gateway_url,
    nickname: args.nickname,
  });
}
function handleRemoveProviderKey(deps: ToolDeps, args: z.infer<typeof removeProviderKeySchema>) {
  return removeProviderKey(deps, args.provider, args.key_id);
}
function handleListProviderKeys(deps: ToolDeps, args: z.infer<typeof listProviderKeysSchema>) {
  return listProviderKeys(deps, args.provider);
}
function handleToggleProviderKey(deps: ToolDeps, args: z.infer<typeof toggleProviderKeySchema>) {
  return toggleProviderKey(deps, args.provider, args.key_id, args.enabled);
}
async function handleDiscoverProviderModels(deps: ToolDeps, args: z.infer<typeof discoverProviderModelsSchema>) {
  return discoverProviderModels(deps, args.provider);
}
function handleListProviderModels(deps: ToolDeps, args: z.infer<typeof listProviderModelsSchema>) {
  return listProviderModels(deps, args.provider, args.registered_only);
}
function handleRegisterProviderModel(deps: ToolDeps, args: z.infer<typeof registerProviderModelSchema>) {
  return registerProviderModel(deps, args.provider, args.model_id);
}
function handleDeregisterProviderModel(deps: ToolDeps, args: z.infer<typeof deregisterProviderModelSchema>) {
  return deregisterProviderModel(deps, args.provider, args.model_id);
}
function handleShowProviderErrors(deps: ToolDeps, args: z.infer<typeof showProviderErrorsSchema>) {
  return showProviderErrors(deps, args.filter);
}
function handleSetProviderEnabled(deps: ToolDeps, args: z.infer<typeof setProviderEnabledSchema>) {
  return setProviderEnabled(deps, args.provider, args.enabled);
}
function handleGetProviderConfig(deps: ToolDeps, _args: z.infer<typeof getProviderConfigSchema>) {
  return getProviderConfig(deps);
}
function handleSetProviderPreferenceOrder(deps: ToolDeps, args: z.infer<typeof setProviderPreferenceOrderSchema>) {
  return setProviderPreferenceOrder(deps, args.order);
}
function handleSeedProviderModels(deps: ToolDeps, args: z.infer<typeof seedProviderModelsSchema>) {
  return seedProviderModels(deps, { profile: args.profile, provider: args.provider, model_ids: args.model_ids });
}
function handleSetRolePin(deps: ToolDeps, args: z.infer<typeof setRolePinSchema>) {
  return setRolePin(deps, { profile: args.profile, role: args.role, provider: args.provider, model_id: args.model_id });
}
function handleListRolePins(deps: ToolDeps, args: z.infer<typeof listRolePinsSchema>) {
  return listRolePins(deps, args.profile);
}
function handleDeleteRolePin(deps: ToolDeps, args: z.infer<typeof deleteRolePinSchema>) {
  return deleteRolePin(deps, args.profile, args.role);
}

export function registerAllTools(server: McpServer, deps: ToolDeps, options: { ui?: UiController } = {}): void {
  // Decoration applies to tools registered during THIS pass only.
  activeUiController = options.ui ?? null;
  // ---- model / inference ----
  register(
    server, deps, "list_models", "List Models",
    "List the models known to the active profile's LM Studio endpoint. Returns a trimmed shape by default; pass verbose for the full model objects.",
    listModelsSchema, handleListModels,
  );
  register(
    server, deps, "get_loaded_model", "Get Loaded Model",
    "Return the models currently loaded into GPU/CPU on the active profile's LM Studio endpoint (loaded_instances non-empty).",
    getLoadedModelSchema, handleGetLoadedModel,
  );
  register(
    server, deps, "load_model", "Load Model",
    "Load a model into the active profile's LM Studio endpoint. model_id is the model key (the identifier shown by list_models); optional load params (context_length, flash_attention, ...) may be passed.",
    loadModelSchema, handleLoadModel,
  );
  register(
    server, deps, "unload_model", "Unload Model",
    "Unload a loaded model instance by its instance_id from the active profile's LM Studio endpoint.",
    unloadModelSchema, handleUnloadModel,
  );
  register(
    server, deps, "chat", "Chat",
    "Send a multi-message chat to a loaded model instance. System messages become the system prompt; output passes through the reply validator/cleaner and includes a validation field describing anything stripped.",
    chatSchema, handleChat,
  );
  register(
    server, deps, "download_model", "Download Model",
    "Ask the active profile's LM Studio endpoint to download a model by HF source id, optionally pinned to a quantization.",
    downloadModelSchema, handleDownloadModel,
  );
  register(
    server, deps, "get_download_status", "Get Download Status",
    "Poll the download progress for a job_id returned by download_model.",
    getDownloadStatusSchema, handleGetDownloadStatus,
  );

  // ---- registry ----
  register(
    server, deps, "read_registry", "Read Registry",
    "Read model-registry entries (roles, scores, best params, last tested) for a profile, optionally filtered to one model_id. Trimmed by default; verbose includes timestamps.",
    readRegistrySchema, handleReadRegistry,
  );
  register(
    server, deps, "write_registry_entry", "Write Registry Entry",
    "Insert or update one registry entry for a profile/model_id. Omitted entry fields keep their existing values.",
    writeRegistryEntrySchema, handleWriteRegistryEntry,
  );
  register(
    server, deps, "share_test_results", "Share Test Results",
    "Copy approved test results from source_profile into profile when both point at the SAME LM Studio instance (endpoint fingerprint: normalized URL + auth presence). Opt-in sharing to avoid redundant regimen runs; different endpoints are refused and stay isolated. Nothing is auto-finalized — a later regimen/finalize aggregates the copied results without re-running the model.",
    shareTestResultsSchema, handleShareTestResults,
  );

  // ---- profiles ----
  register(
    server, deps, "create_profile", "Create Profile",
    "Create a named profile. Machine specs, endpoint, pricing, test_plan_ref and ntfy are optional and resolve to documented defaults; concurrency is derived from machine specs via the guardrail tiers.",
    createProfileSchema, handleCreateProfile,
  );
  register(
    server, deps, "switch_profile", "Switch Profile",
    "Make a named profile the active one. All subsequent model tools use its endpoint until switched again.",
    switchProfileSchema, handleSwitchProfile,
  );
  register(
    server, deps, "update_profile", "Update Profile",
    "Partially update a named profile (machine specs, endpoint, pricing, ntfy, inference effort/ceiling, theme, tool grant). Omitted fields keep their current values. Used by /nanites-effort to set the active profile's effort.",
    updateProfileSchema, handleUpdateProfile,
  );
  register(
    server, deps, "list_profiles", "List Profiles",
    "List profile names. Pass verbose for full profile objects.",
    listProfilesSchema, handleListProfiles,
  );
  register(
    server, deps, "get_active_profile", "Get Active Profile",
    "Return the currently active profile, or null if none has been switched to yet.",
    getActiveProfileSchema, handleGetActiveProfile,
  );
  register(
    server, deps, "get_first_run_status", "Get First Run Status",
    "Report whether Nanites needs first-run initialization: true exactly when zero profiles exist. The orchestrator calls this once at session start; when true, it runs the /nanites-new-profile flow.",
    firstRunStatusSchema, handleFirstRunStatus,
  );

  // ---- test units ----
  register(
    server, deps, "list_test_units", "List Test Units",
    "List the registered test units for a profile (the default regimen is registered automatically on first use).",
    listTestUnitsSchema, handleListTestUnits,
  );
  register(
    server, deps, "validate_test_unit", "Validate Test Unit",
    "Validate a test-unit object against the schema/validator rules without persisting it. Returns { ok, issues }.",
    validateTestUnitSchema, handleValidateTestUnit,
  );
  register(
    server, deps, "register_test_unit", "Register Test Unit",
    "Validate and persist a test unit for a profile. Rejects invalid units with the issues listed; duplicate ids are refused.",
    registerTestUnitSchema, handleRegisterTestUnit,
  );

  // ---- workflow tools (Phase 7+) — surface only until their phase lands ----
  register(
    server, deps, "run_test_regimen", "Run Test Regimen",
    "Test one model against the profile's registered test units (the default regimen is auto-registered on first use). Loads the model, runs deterministic units inline with a logged param search, runs orchestrator_judged units to pending, unloads exactly once, and writes the registry entry when nothing is pending. Returns only pending_unit_ids, never raw output.",
    runTestRegimenSchema, handleRunTestRegimen,
  );
  register(
    server, deps, "get_pending_judgments", "Get Pending Judgments",
    "Fetch cleaned raw output plus rubric and prompt context for pending orchestrator-judged units (all, or a requested subset) for the orchestrator to read and judge in the same turn.",
    getPendingJudgmentsSchema, handleGetPendingJudgments,
  );
  register(
    server, deps, "submit_test_judgment", "Submit Test Judgment",
    "Record an orchestrator judgment for one pending unit. Nothing becomes final in the registry until user_approved is true; a submission with user_approved false records the judgment without finalizing that score.",
    submitTestJudgmentSchema, handleSubmitTestJudgment,
  );
  register(
    server, deps, "run_sub_agent", "Run Sub-Agent",
    "Delegate one bounded task to a local model. Resolves the model from the profile's registry by roles (or an explicit model_id), acquires a model respecting the profile's concurrency tier (reuse already-loaded, evict on sequential tiers, refuse at parallel capacity), runs the brief once, cleans the reply, unloads exactly once if it loaded the model, and logs exactly one token-usage entry for cost tracking.",
    runSubAgentSchema, handleRunSubAgent,
  );
  register(
    server, deps, "start_sub_agent_job", "Start Sub-Agent Job",
    "Queue a sub-agent job on the profile's async job FIFO and return its job_id immediately (non-blocking — for long-horizon work on slow/big models instead of a tool call that blocks for minutes). Same validated inputs as run_sub_agent; when the profile's concurrency tier is at capacity the job waits queued rather than erroring. Poll with get_sub_agent_job_status.",
    startSubAgentJobSchema, handleStartSubAgentJob,
  );
  register(
    server, deps, "get_sub_agent_job_status", "Get Sub-Agent Job Status",
    "Poll a sub-agent job started with start_sub_agent_job. Returns { job_id, status: queued|running|done|error, result? }; result is present for done (shaped like run_sub_agent's response) and error (structured { code, message, retryable }).",
    getSubAgentJobStatusSchema, handleGetSubAgentJobStatus,
  );
  register(
    server, deps, "start_btw_chat", "Start /nanites-btw Chat",
    "Start a /nanites-btw working-memory chat for a profile: replaces the active chat row and wipes its old transcript (the compaction caches persist), enqueues compaction of the given host-session transcript as an async job (returns immediately — it can never stall or eject a running job), pins and holds a context_qa model when the job completes, and answers initial_question inline if it finishes inside the ~5s grace window. Returns the dashboard deep link (open it in the preview) plus the job handle and status.",
    startBtwChatSchema, handleStartBtwChat,
  );
  register(
    server, deps, "diff_untested", "Diff Untested Models",
    "List downloaded LLM models on the profile's endpoint that have no registry entry yet (the Workflow #3 discovery step). Returns a trimmed per-model shape.",
    diffUntestedSchema, handleDiffUntested,
  );
  register(
    server, deps, "run_untested_sweep", "Run Untested Sweep",
    "Workflow #3 end to end: diff downloaded LLM models against the registry and run Workflow #1 (run_test_regimen) on each unregistered model, sequentially.",
    runUntestedSweepSchema, handleRunUntestedSweep,
  );
  register(
    server, deps, "download_and_wait", "Download And Wait",
    "Workflow #4 download half: ask LM Studio to download a model by HF source id, then poll download status with exponential backoff until completed/failed/paused (or a poll ceiling).",
    downloadAndWaitSchema, handleDownloadAndWait,
  );
  register(
    server, deps, "download_and_test", "Download And Test",
    "Workflow #4 end to end: download_and_wait, then on completion trigger Workflow #1 (run_test_regimen) on the newly downloaded model automatically. A failed/paused/gave-up download returns without testing.",
    downloadAndTestSchema, handleDownloadAndTest,
  );
  register(
    server, deps, "filter_by_guardrail", "Filter By Guardrail",
    "Shortlist candidate models (e.g. Hugging Face search results the host gathered via its HF connector) against the profile's machine-spec guardrail tier. Excludes models far outside the tier's recommended size range with an explicit reason; never silently suggests.",
    filterByGuardrailSchema, handleFilterByGuardrail,
  );
  register(
    server, deps, "get_cost_saved_report", "Get Cost Saved Report",
    "Report tokens and estimated USD saved by delegating work to local models, from real logged sub-agent usage over a period (all/day/week/month) at the profile's input/output rates. Local delegation costs ~$0, so saved_usd is the orchestrator-equivalent cost not spent.",
    getCostSavedReportSchema, handleGetCostSavedReport,
  );
  register(
    server, deps, "check_adaptation", "Check Adaptation",
    "Check whether a profile's use case diverges from nanites-default. When it does, returns a user prompt asking whether to draft custom test units, plus the default-plan notice that reusing the default plan may not be well-calibrated.",
    checkAdaptationSchema, handleCheckAdaptation,
  );
  register(
    server, deps, "register_adapted_units", "Register Adapted Units",
    "Validate a batch of authored test units through the Phase 4 validator and register the ones that pass; each rejected unit is returned with its validation issues surfaced, never silently dropped or force-registered.",
    registerAdaptedUnitsSchema, handleRegisterAdaptedUnits,
  );
  register(
    server, deps, "system_health_check", "System Health Check",
    "Check LM Studio health for a profile: endpoint reachability (with a one-shot lms server start autostart recovery and recheck), free disk space for downloads, and stuck-loaded-model detection. Returns an overall status (healthy/degraded/down) plus per-check sub-fields.",
    systemHealthCheckSchema, handleSystemHealthCheck,
  );
  register(
    server, deps, "send_ntfy", "Send Notification",
    "Fire-and-forget push notification to the profile's ntfy topic (public-server default resolution per profile config). A failed push never fails the underlying operation; it is logged server-side only.",
    sendNtfySchema, handleSendNtfy,
  );
  // ---- online providers ----
  register(server, deps, "nanites_addProviderKey", "Add Provider Key", "Add an API key for a cloud provider (Cloudflare, OpenRouter, OmniRoute, Generic).", addProviderKeySchema, handleAddProviderKey);
  register(server, deps, "nanites_removeProviderKey", "Remove Provider Key", "Remove an API key from a cloud provider.", removeProviderKeySchema, handleRemoveProviderKey);
  register(server, deps, "nanites_listProviderKeys", "List Provider Keys", "List all API keys for a cloud provider.", listProviderKeysSchema, handleListProviderKeys);
  register(server, deps, "nanites_toggleProviderKey", "Toggle Provider Key", "Enable or disable an API key for a cloud provider.", toggleProviderKeySchema, handleToggleProviderKey);
  register(server, deps, "nanites_discoverProviderModels", "Discover Provider Models", "Auto-discover available models from a cloud provider.", discoverProviderModelsSchema, handleDiscoverProviderModels);
  register(server, deps, "nanites_listProviderModels", "List Provider Models", "List cached models from a cloud provider.", listProviderModelsSchema, handleListProviderModels);
  register(server, deps, "nanites_registerProviderModel", "Register Provider Model", "Register a discovered model for use with a cloud provider.", registerProviderModelSchema, handleRegisterProviderModel);
  register(server, deps, "nanites_deregisterProviderModel", "Deregister Provider Model", "Deregister a registered model from a cloud provider.", deregisterProviderModelSchema, handleDeregisterProviderModel);
  register(server, deps, "nanites_showProviderErrors", "Show Provider Errors", "Show recent errors from cloud provider calls.", showProviderErrorsSchema, handleShowProviderErrors);
  register(server, deps, "nanites_setProviderEnabled", "Set Provider Enabled", "Enable or disable a cloud provider globally.", setProviderEnabledSchema, handleSetProviderEnabled);
  register(server, deps, "nanites_getProviderConfig", "Get Provider Config", "Get provider preference order and per-provider settings.", getProviderConfigSchema, handleGetProviderConfig);
  register(server, deps, "nanites_setProviderPreferenceOrder", "Set Provider Preference Order", "Set the global provider preference order for cloud routing.", setProviderPreferenceOrderSchema, handleSetProviderPreferenceOrder);
  register(server, deps, "seed_provider_models", "Seed Provider Models", "Bulk-register the canonical Cloudflare agentic models (canonical manifest), role-tag them in the registry, and write the default role pins. Idempotent; unknown model ids are refused before anything is written.", seedProviderModelsSchema, handleSeedProviderModels);
  register(server, deps, "set_role_pin", "Set Role Pin", "Pin a role to a preferred (provider, model). Auto-route by pin on later sub-agent runs; falls back to dynamic when the pinned target is unusable.", setRolePinSchema, handleSetRolePin);
  register(server, deps, "list_role_pins", "List Role Pins", "List the role->model pins for a profile (default active).", listRolePinsSchema, handleListRolePins);
  register(server, deps, "delete_role_pin", "Delete Role Pin", "Remove a role pin so that role falls back to dynamic model selection.", deleteRolePinSchema, handleDeleteRolePin);
}
