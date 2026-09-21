// TypeSafe "System One" (jev) — a decision provider, not a chat model. It answers
// typed questions (`choice`/`score`/`noul`) with calibrated probabilities in
// ~350ms and produces no text at all, so it can never serve a completion.
//
// Deliberately has NO `transport` and NO `models`:
//   - without `transport`, open-sse/providers/index.js never assigns PROVIDERS.jev,
//     which keeps verify-providers.mjs and verify-alias.mjs green untouched;
//   - `models` must be absent, not empty — `models: []` would create
//     PROVIDER_MODELS["jev"] and break the alias baseline.
//
// `alias` stays "jev". Claiming "vercel" or "openrouter" would hijack the alias
// map (open-sse/services/model.js builds it by overwrite, last entry winning) and
// silently steal the existing chat providers' aliases.

export default {
  id: "jev",
  alias: "jev",
  uiAlias: "jev",
  display: {
    name: "Jev (System One)",
    icon: "psychology_alt",
    color: "#7C3AED",
    textIcon: "JV",
    website: "https://typesafe.ai",
    notice: {
      text: "System One decision model from TypeSafe. Answers typed questions with calibrated probabilities - it picks the model or the tool; it never writes the answer. Reuses the Vercel AI Gateway credential, so no new key is needed.",
      apiKeyUrl: "https://vercel.com/dashboard/ai-gateway/api-keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: ["decision"],
  noAuth: false,
  decisionConfig: {
    // Every route takes the same body ({ model, state, questions }) and returns
    // the same shape, so one client serves all of them. Only Vercel ships enabled
    // in v1; the others are one array entry away.
    routes: [
      {
        id: "vercel",
        label: "Vercel AI Gateway",
        url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
        model: "typesafe-ai/jev",
        credentialProvider: "vercel-ai-gateway",
      },
    ],
    defaultRoute: "vercel",
    timeoutMs: 800,
    minConfidence: 0.7,
    switchConfidence: 0.85,
    maxStateChars: 24000,
  },
};
