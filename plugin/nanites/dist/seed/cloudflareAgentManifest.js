export const CLOUDFLARE_AGENT_MANIFEST = [
    {
        model_id: "@cf/openai/gpt-oss-120b",
        tier: "T1",
        roles: ["code_writer", "refactorer", "code_qa", "reviewer", "commit_writer"],
        vision: false,
        function_calling: true,
        reasoning: true,
        context_length: 128000,
        pricing_prompt: 0.35,
        pricing_completion: 0.75,
    },
    {
        model_id: "@cf/nvidia/nemotron-3-120b-a12b",
        tier: "T1",
        roles: ["summarizer", "extractor", "doc_writer", "code_qa", "reviewer"],
        vision: false,
        function_calling: true,
        reasoning: true,
        context_length: 256000,
        pricing_prompt: 0.5,
        pricing_completion: 1.5,
    },
    {
        model_id: "@cf/openai/gpt-oss-20b",
        tier: "T1",
        roles: ["code_writer", "commit_writer", "reviewer"],
        vision: false,
        function_calling: true,
        reasoning: true,
        context_length: 128000,
        pricing_prompt: 0.2,
        pricing_completion: 0.3,
    },
    {
        model_id: "@cf/qwen/qwen3-30b-a3b-fp8",
        tier: "T1",
        roles: ["summarizer", "doc_writer", "classifier", "extractor"],
        vision: false,
        function_calling: true,
        reasoning: true,
        context_length: 32768,
        pricing_prompt: 0.0509,
        pricing_completion: 0.335,
    },
    {
        model_id: "@cf/zai-org/glm-4.7-flash",
        tier: "T1",
        roles: ["reviewer", "code_qa", "summarizer", "test_writer"],
        vision: false,
        function_calling: true,
        reasoning: true,
        context_length: 131072,
        pricing_prompt: 0.0605,
        pricing_completion: 0.4,
    },
    {
        model_id: "@cf/google/gemma-4-26b-a4b-it",
        tier: "T1",
        roles: ["vision", "summarizer", "extractor", "code_qa"],
        vision: true,
        function_calling: true,
        reasoning: true,
        context_length: 256000,
        pricing_prompt: 0.1,
        pricing_completion: 0.3,
    },
    {
        model_id: "@cf/qwen/qwen3.8-27b",
        tier: "T1",
        roles: ["vision", "reviewer", "summarizer", "doc_writer"],
        vision: true,
        function_calling: true,
        reasoning: true,
        context_length: 262144,
        pricing_prompt: 0.05,
        pricing_completion: 3.2,
    },
    {
        model_id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        tier: "T2",
        roles: ["reviewer", "test_writer", "doc_writer", "code_qa"],
        vision: false,
        function_calling: true,
        reasoning: false,
        context_length: 24000,
        pricing_prompt: 0.293,
        pricing_completion: 2.253,
    },
    {
        model_id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
        tier: "T2",
        roles: ["vision", "test_writer", "extractor", "doc_writer", "code_qa"],
        vision: true,
        function_calling: true,
        reasoning: false,
        context_length: 128000,
        pricing_prompt: 0.351,
        pricing_completion: 0.555,
    },
    {
        model_id: "@cf/meta/llama-4-scout-17b-16e-instruct",
        tier: "T2",
        roles: ["vision", "test_writer", "reviewer", "code_qa"],
        vision: true,
        function_calling: true,
        reasoning: false,
        context_length: 131000,
        pricing_prompt: 0.27,
        pricing_completion: 0.85,
    },
    {
        model_id: "@cf/ibm-granite/granite-4.0-h-micro",
        tier: "T2",
        roles: ["classifier", "extractor", "summarizer"],
        vision: false,
        function_calling: true,
        reasoning: false,
        context_length: 131000,
        pricing_prompt: 0.017,
        pricing_completion: 0.112,
    },
    {
        model_id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        tier: "T3",
        roles: ["reviewer", "code_qa", "code_writer", "extractor"],
        vision: false,
        function_calling: false,
        reasoning: true,
        context_length: 80000,
        pricing_prompt: 0.497,
        pricing_completion: 4.881,
    },
    {
        model_id: "@cf/qwen/qwq-32b",
        tier: "T3",
        roles: ["classifier", "extractor", "summarizer", "reviewer"],
        vision: false,
        // Corrected to true in C5: 2/2 live runs returned `finish_reason:"tool_calls"`
        // with a real read_file call, though CF advertises no `function_calling`
        // property for this model.
        function_calling: true,
        reasoning: true,
        context_length: 24000,
        pricing_prompt: 0.66,
        pricing_completion: 1.0,
    },
    {
        model_id: "@cf/meta/llama-3.2-11b-vision-instruct",
        tier: "vision",
        roles: ["vision"],
        vision: true,
        // Absent property and no live evidence — every probe call answered HTTP 403
        // code 5016 (Meta Community License not accepted on any account). The gate
        // stays conservative until an account accepts the agreement and a probe can
        // actually reach the model.
        function_calling: false,
        reasoning: false,
        context_length: 128000,
        pricing_prompt: 0.0485,
        pricing_completion: 0.676,
    },
];
export const VISION_CAPABLE_MODELS = CLOUDFLARE_AGENT_MANIFEST.filter((m) => m.vision).map((m) => m.model_id);
/**
 * Default pins for the named job types + vision.
 *
 * Corrected in the same capability audit. Two rules govern every entry here:
 *
 * 1. **Tool-using roles must pin a tool-capable model.** `extractor` was pinned
 *    to `deepseek-r1-distill-qwen-32b`, which this manifest marks
 *    `function_calling: false` — that pin could only ever produce a run that
 *    silently ignored its tools.
 * 2. **Context window outranks raw quality for tool-loop roles.** A 7-round
 *    loop carries the whole transcript, so the 24k models
 *    (`llama-3.3-70b`, `llama-3.4-scout`) are a poor default for `reviewer`
 *    however good they are at review; `glm-4.7-flash` has 131k and is
 *    tool-capable. The published model guide recommends llama-3.3-70b for
 *    reviewer, and that recommendation is deliberately not followed here for
 *    this reason.
 * 3. **Cheap non-reasoning models for classification and extraction** — those
 *    roles want throughput, and a reasoning model spends its budget thinking
 *    before it answers.
 */
export const CLOUDFLARE_DEFAULT_PINS = [
    { role: "code_writer", model_id: "@cf/openai/gpt-oss-120b" },
    { role: "refactorer", model_id: "@cf/openai/gpt-oss-120b" },
    { role: "code_qa", model_id: "@cf/openai/gpt-oss-120b" },
    { role: "test_writer", model_id: "@cf/openai/gpt-oss-120b" },
    { role: "doc_writer", model_id: "@cf/nvidia/nemotron-3-120b-a12b" },
    { role: "reviewer", model_id: "@cf/zai-org/glm-4.7-flash" },
    { role: "classifier", model_id: "@cf/ibm-granite/granite-4.0-h-micro" },
    { role: "extractor", model_id: "@cf/qwen/qwen3-30b-a3b-fp8" },
    { role: "vision", model_id: "@cf/google/gemma-4-26b-a4b-it" },
];
