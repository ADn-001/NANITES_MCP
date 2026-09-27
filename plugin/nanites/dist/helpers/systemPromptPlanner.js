function blocks(...parts) {
    return parts.filter((p) => Boolean(p && p.trim())).join("\n\n");
}
export function buildSystemPrompt(input) {
    const { max_parallel_models: processCap, num_parallel: slots } = input.profile.concurrency;
    const tier = input.profile.concurrency.mode === "sequential"
        ? `${input.profile.machine_specs.vram_gb}GB VRAM, sequential ${processCap}x${slots}, one inference at a time`
        : `${input.profile.machine_specs.vram_gb}GB VRAM, parallel ${processCap}x${slots}`;
    const mode = input.profile.dynamic_model ? "dynamic role-based selection" : "your own currently-loaded model";
    const reasoningNote = input.reasoningType === "non_reasoning" ? "" : " Reason before answering when the task warrants it.";
    const identity = "You are a Nanites sub-agent on a local workstation. You are the delegate, not the orchestrator: you receive one self-contained task and return one answer.";
    const scope = blocks(`Scope: use-case "${input.profile.use_case}". Hardware: ${tier}. Effort level: ${input.profile.effort}. Selection mode: ${mode}.`, `You are running as ${input.role || "a general sub-agent"}. Stay within the task; do not extend beyond what is asked.`);
    const toolBlock = input.toolManifest && input.toolManifest.length > 0
        ? `You may only act through the following tools — never by inventing file access:\n${JSON.stringify(input.toolManifest.map((t) => t.name))}`
        : null;
    return blocks(input.profile.system_prompt ?? null, identity, scope, toolBlock) + reasoningNote;
}
