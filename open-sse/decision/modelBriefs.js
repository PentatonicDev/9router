// "What this model is FOR" — the criteria jev reads when picking from a pool. This
// text is the feature: price + capability flags decided 0/4 correctly against 5/5
// for these briefs (measured), because "reasoning: true, 1000k context" says nothing
// while "root-cause debugging of intermittent production bugs" says everything.
//
// No price reaches this text. Arithmetic over a rate table is a documented weakness
// of the decision model, and a brief carrying "$5/M in" asks for exactly that. Cost
// is the pool's own ordering, applied in code after the model has judged fitness.
//
// Keyed by canonical model id.

import { getCapabilitiesForModel } from "../providers/capabilities.js";

export const MODEL_BRIEFS = {
  // === Anthropic ===
  "claude-haiku-4.5":
    "Cheapest and fastest. Use for mechanical edits, renames, formatting, lookups, lint, single-command work, and summarising. Do NOT use for architecture, hard debugging, or multi-file refactors.",
  "claude-haiku-4-5-20251001":
    "Cheapest and fastest. Use for mechanical edits, renames, formatting, lookups, lint, single-command work, and summarising. Do NOT use for architecture, hard debugging, or multi-file refactors.",
  "claude-sonnet-4.5":
    "Balanced. Use for implementing features, writing tests, medium-scope refactors, and multi-file work with clear requirements.",
  "claude-sonnet-4.6":
    "Balanced. Use for implementing features, writing tests, medium-scope refactors, and multi-file work with clear requirements.",
  "claude-sonnet-5":
    "Balanced. Use for implementing features, writing tests, medium-scope refactors, and multi-file work with clear requirements.",
  "claude-opus-4.5":
    "Strong reasoning. Use for architecture, root-cause debugging of non-obvious bugs, race conditions, intermittent production faults, and design decisions with trade-offs.",
  "claude-opus-4.6":
    "Strong reasoning. Use for architecture, root-cause debugging of non-obvious bugs, race conditions, intermittent production faults, and design decisions with trade-offs.",
  "claude-opus-5":
    "Strong reasoning. Use for architecture, root-cause debugging of non-obvious bugs, race conditions, intermittent production faults, and design decisions with trade-offs.",
  "claude-fable-5":
    "Most expensive and most capable. Reserve for long, ambiguous, high-stakes work where being wrong costs more than the tokens.",

  // === DeepSeek ===
  "deepseek-flash":
    "Cheap and fast with native reasoning. Use for mechanical edits, formatting, lookups, and short commands. Good at code for its cost.",
  "deepseek-chat":
    "Mid-range reasoning. Use for straightforward code work and multi-step tasks with clear requirements.",
  "deepseek-reasoner":
    "Strong reasoning. Use for harder debugging and multi-file work where the cheap model is not enough.",

  // === GLM (Zhipu) ===
  "glm-5.3-flash":
    "Cheap and fast with native reasoning and long context. Use for mechanical edits, formatting, lookups, and summarising long documents.",
  "glm-5.2":
    "Mid-range reasoning. Use for straightforward implementation and medium-scope refactors.",

  // === OpenAI ===
  "gpt-5-mini":
    "Small and cheap. Use for mechanical edits, formatting, short lookups, and summarising.",
  "gpt-5.1-codex-mini":
    "Small and cheap, tuned for code. Use for localised code edits and mechanical changes; keep the context short.",
  "gpt-5.1-codex-max":
    "Expensive and tuned for code. Use for large, long-running coding tasks where depth matters more than cost.",
  "gpt-5.3-codex":
    "Code-tuned and mid-priced. Use for dense code editing and localised refactors with clear requirements.",
  "gpt-5.3-codex-spark":
    "Code-tuned and fast, but with a short context. Use for dense code editing and localised refactors; avoid tasks needing a lot of accumulated context.",
  "gpt-5.6-luna":
    "Cheap and general. Use for straightforward implementation and mechanical work when a Claude model is unavailable.",
  "gpt-5.6-terra":
    "Balanced mid-range. Use for implementing features, tests, and refactors with clear requirements — similar capability to Sonnet.",
  "gpt-5.6-sol":
    "Strong and expensive. Use for difficult reasoning, architecture, and debugging at the same tier as the top Claude models.",
  "gpt-6-astra":
    "Strong generalist. Use when the task mixes code and broad reasoning without being deep debugging.",
};

/**
 * The criteria for one model: the operator's own brief, then the table above, then
 * price + capability flags.
 *
 * ponytail: the third step is measured bad (0/4; only the confidence threshold
 * stopped it routing wrong). It is a floor for unknown models, not a substitute
 * for a brief.
 */
export function resolveCriteria({ provider, model, briefs = {}, maxChars = 600 }) {
  const id = String(model || "");
  const override = briefs[`${provider}/${id}`] || briefs[id];
  // Exact match, then vendor-prefix strip ("anthropic/..." → "..."), then Bedrock geo.vendor prefix
  // ("global.anthropic.claude-..." → "claude-..."), then family prefix match.
  const canonical = stripBedrockPrefix(id);
  const curated = MODEL_BRIEFS[id]
    || briefsFor(vendorSuffix(id))
    || (canonical !== id ? briefsFor(canonical) : null)
    || matchSuffix(MODEL_BRIEFS, canonical);
  return truncateText(override || curated || describeCapabilities(provider, id), maxChars);
}


function describeCapabilities(provider, model) {
  const caps = getCapabilitiesForModel(provider, model) || {};
  const bits = [];
  if (caps.reasoning) bits.push("supports native reasoning");
  if (caps.contextWindow) bits.push(`${Math.round(caps.contextWindow / 1000)}k context`);
  if (caps.vision) bits.push("reads images");
  return bits.length ? bits.join(", ") + "." : "";
}

/** Passthrough ids carry a vendor prefix ("anthropic/claude-haiku-4.5"); the table
 *  is keyed by the bare id, and a miss falls silently to the bad derived criteria. */
function vendorSuffix(id) {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : null;
}

function briefsFor(id) {
  if (!id) return null;
  return MODEL_BRIEFS[id] || MODEL_BRIEFS[stripBedrockPrefix(id)] || null;
}

/** Bedrock ids carry a geo and vendor prefix: "global.anthropic.claude-opus-4-6-v1".
 *  The brief table is keyed by the canonical name, so strip to "claude-opus-4-6-v1",
 *  then match against family prefixes like "claude-opus-" because versions diverge.  */
function stripBedrockPrefix(id) {
  // "global.anthropic.claude-..." → "claude-..."
  const parts = id.split(".");
  for (let i = 0; i < parts.length; i++) {
    const rest = parts.slice(i).join(".");
    if (MODEL_BRIEFS[rest]) return rest;
    // Try matching against any existing key prefix: "claude-opus-4-6-v1" starts with "claude-opus-"
    const match = matchSuffix(MODEL_BRIEFS, rest);
    if (match !== null) return rest; // Return the id, not the matched brief text
  }
  return id;
}

/** Versioned ids fall back to their family brief. Extract base model name by stripping
 *  version/revision segments from the end: "claude-opus-4-6-v1" → "claude-opus",
 *  then match against keys with the same base name. */
function matchSuffix(table, id) {
  const baseId = extractBaseName(id);
  for (const key of Object.keys(table)) {
    if (extractBaseName(key) === baseId) return table[key];
  }
  return null;
}

function extractBaseName(id) {
  const parts = id.split("-");
  const result = [];
  for (const part of parts) {
    // Stop at: pure digits, 8-digit dates, v-prefixed versions, or anything with :
    if (/^\d+$/.test(part) || /^\d{8}$/.test(part) || /^v\d/.test(part) || part.includes(":")) break;
    result.push(part);
  }
  return result.join("-") || id;
}

function truncateText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
