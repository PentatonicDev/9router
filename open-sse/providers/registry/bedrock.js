// Amazon Bedrock — Converse/ConverseStream API, one generic executor for every
// vendor Bedrock hosts. See open-sse/executors/bedrock.js + AGENTS.md before touching this.
//
// providerSpecificData (per connection, validated in src/lib/providerNormalization.js):
//   { authMethod: "api_key"|"iam", region, inferenceProfilePrefix, endpoint?,
//     accessKeyId?, secretAccessKey?, sessionToken? }  (last three only for authMethod:"iam")
//
// Model ids below are Bedrock's own foundation-model ids (vendor.family-version:revision).
// Anthropic ones mirror the direct-API dates already in providers/pricing.js MODEL_PRICING
// (Bedrock ships the same model on the same release date). Non-Anthropic ids/prices are
// training-knowledge, NOT fetched live from the AWS console/pricing API in this pass —
// spot-check every non-Anthropic id + PROVIDER_PRICING.bedrock rate before enabling in prod.
export default {
  id: "bedrock",
  alias: "br",
  display: {
    name: "Amazon Bedrock",
    icon: "cloud",
    color: "#FF9900",
    textIcon: "BR",
    website: "https://aws.amazon.com/bedrock/",
    notice: {
      text: "API key (bearer token) or IAM access key/secret. Region can be any AWS region, or \"global\" for Bedrock's cross-region global endpoint.",
      apiKeyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey", "iam"],
  hasProviderSpecificData: true,
  transport: {
    // SDK derives the endpoint from region/endpoint override — no static baseUrl.
    baseUrl: null,
    format: "bedrock-converse",
    executor: "bedrock",
    forceStream: true,
  },
  models: [
    // === Anthropic (pricing parity with direct API — see PROVIDER_PRICING.bedrock) ===
    { id: "anthropic.claude-opus-4-1-20250805-v1:0", name: "Claude Opus 4.1" },
    { id: "anthropic.claude-opus-4-5-20251101-v1:0", name: "Claude Opus 4.5" },
    { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5" },
    { id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" },

    // === Amazon Nova ===
    { id: "amazon.nova-micro-v1:0", name: "Nova Micro" },
    { id: "amazon.nova-lite-v1:0", name: "Nova Lite" },
    { id: "amazon.nova-pro-v1:0", name: "Nova Pro" },
    { id: "amazon.nova-premier-v1:0", name: "Nova Premier" },

    // === Meta Llama ===
    { id: "meta.llama3-3-70b-instruct-v1:0", name: "Llama 3.3 70B" },
    { id: "meta.llama4-scout-17b-instruct-v1:0", name: "Llama 4 Scout" },
    { id: "meta.llama4-maverick-17b-instruct-v1:0", name: "Llama 4 Maverick" },

    // === Mistral ===
    { id: "mistral.mistral-large-2407-v1:0", name: "Mistral Large" },
    { id: "mistral.pixtral-large-2502-v1:0", name: "Pixtral Large" },

    // === DeepSeek ===
    { id: "deepseek.r1-v1:0", name: "DeepSeek R1" },
    // ponytail: id unverified against the live AWS console — DeepSeek V3 availability
    // as a Bedrock foundation-model id (vs. marketplace/custom-import only) was not
    // confirmed in this pass. Verify before relying on it.
    { id: "deepseek.v3-v1:0", name: "DeepSeek V3" },

    // === Qwen ===
    // ponytail: ids unverified — Qwen3 landed on Bedrock after this session's
    // training cutoff context; confirm exact ids in the AWS console before enabling.
    { id: "qwen.qwen3-32b-v1:0", name: "Qwen3 32B" },
    { id: "qwen.qwen3-coder-480b-a35b-v1:0", name: "Qwen3 Coder 480B" },

    // === Cohere ===
    { id: "cohere.command-r-plus-v1:0", name: "Command R+" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};
