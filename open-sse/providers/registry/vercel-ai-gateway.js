export default {
  id: "vercel-ai-gateway",
  priority: 160,
  alias: "vercel-ai-gateway",
  aliases: [
    "vercel",
  ],
  uiAlias: "vercel",
  display: {
    name: "Vercel AI Gateway",
    icon: "deployed_code",
    color: "#111827",
    textIcon: "VG",
    website: "https://vercel.com/ai-gateway",
    notice: {
      text: "Unified OpenAI-compatible endpoint from Vercel. Use your AI Gateway API key, then pick models with provider/model IDs like anthropic/claude-sonnet-4.6 or openai/gpt-5.4.",
      apiKeyUrl: "https://vercel.com/dashboard/~/ai-gateway",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://ai-gateway.vercel.sh/v1/chat/completions",
    thinkingFormat: "openai",
    retry: {
      "429": 2,
    },
    usage: {
      url: "https://ai-gateway.vercel.sh/v1/credits",
    },
  },
  // "decision": this gateway answers System One typed questions as well as chat,
  // so it is one of the providers the Decisions tool lists. The decision model is
  // a field, not a provider identity — when a better System-1 model ships, change
  // the model and nothing else.
  serviceKinds: ["llm","embedding","image","imageToText","webSearch","decision"],
  embeddingConfig: { baseUrl: "https://ai-gateway.vercel.sh/v1/embeddings" },
  imageConfig: { baseUrl: "https://ai-gateway.vercel.sh/v1/images/generations" },
  searchViaChat: { defaultModel: "openai/gpt-4o-mini", pricingUrl: "https://vercel.com/docs/ai-gateway/pricing" },
  // Decision routing through this gateway. `path` is resolved against the chat
  // transport's origin, so the route moves with the gateway rather than being a
  // second hardcoded host. Decision models are advertised in the gateway's own
  // catalog with `type: "evaluation"` (and `max_tokens: 0`), which is how the
  // panel tells them apart from chat models.
  decisionConfig: {
    path: "/typesafe/v1/systemone",
    modelType: "evaluation",
    defaultModel: "typesafe-ai/jev",
    timeoutMs: 1500,
  },
  modelsFetcher: { url: "https://ai-gateway.vercel.sh/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
