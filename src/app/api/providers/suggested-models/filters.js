// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Upstream returns "Model is unavailable" for this id (2026-09-02) — re-enable when fixed
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // A plain OpenAI-shaped /v1/models catalog: `{ data: [{ id, name?, ... }] }`.
  // Only language models, and only free ones with ≥200k context — the label says
  // "Suggested free models (≥200k context)" and the previous version returned the
  // entire catalog (380 entries including paid and non-language models).
  "openai": (models) =>
    (Array.isArray(models) ? models : models?.data || [])
      .filter((m) => typeof m?.id === "string" && m.id
        && (!m.type || m.type === "language")
        && (m.context_window || m.context_length || 0) >= 200000
        && String(m.pricing?.input || "1") === "0"
        && String(m.pricing?.output || "1") === "0")
      .map((m) => ({ id: m.id, name: m.name || m.display_name || m.id, contextLength: m.context_window || m.context_length }))
      .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0)),

  "airforce-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => (m.tier === "free" || m.id?.endsWith(":free")) && m.supports_chat === true && (!m.media_type || m.media_type === "chat" || m.media_type === "text"))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
};
