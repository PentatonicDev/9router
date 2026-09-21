// "What this model is FOR" — the criteria jev reads when picking a model from a
// pool. This text is the feature: measured on the same pool and the same tasks,
// a criteria built from price + capability flags decided 0/4 correctly
// (confidence 0.43–0.47, discarded by the threshold), while these briefs decided
// 5/5 (confidence 0.96–0.99), including the hard case — a production race
// condition routed to the reasoning model instead of the cheapest one.
//
// "reasoning: true, context 1000k" tells jev nothing. "architectural decisions,
// root-cause debugging of intermittent production bugs" tells it everything.
//
// Keys are canonical model ids (provider-agnostic), matching MODEL_PRICING's
// shape in open-sse/providers/pricing.js. Price is NOT baked in here — it is
// appended live from getPricingForModel so the text never goes stale.

import { getPricingForModel } from "../providers/pricing.js";
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
  "gpt-5.6-sol":
    "Strong and expensive. Use for difficult reasoning, architecture, and debugging at the same tier as the top Claude models.",
  "gpt-6-astra":
    "Strong generalist. Use when the task mixes code and broad reasoning without being deep debugging.",
};

/**
 * The criteria jev reads for one model. Resolution order:
 *   1. what the operator wrote for this model (their pool, their intent)
 *   2. the curated table above
 *   3. price + capability flags
 *
 * ponytail: step 3 is measured BAD — it decided 0/4 correctly and only avoided
 * wrong routing because the confidence threshold discarded it. It exists so an
 * unknown model still gets *some* criterion rather than none; if you add a model
 * you care about, add a brief instead of trusting this.
 */
export function resolveCriteria({ provider, model, briefs = {}, maxChars = 600 }) {
  const id = String(model || "");
  const override = briefs[`${provider}/${id}`] || briefs[id];
  const curated = MODEL_BRIEFS[id] || briefsFor(vendorSuffix(id)) || matchSuffix(MODEL_BRIEFS, id);

  const price = getPricingForModel(provider, id);
  const cost = price && typeof price.input === "number" ? describeCost(price) : "";
  const body = override || curated || describeCapabilities(provider, id);

  return truncateText([body, cost].filter(Boolean).join(" "), maxChars);
}

function describeCost(price) {
  const bits = [`$${price.input}/M in`];
  if (typeof price.cached === "number") bits.push(`$${price.cached}/M cached`);
  if (typeof price.output === "number") bits.push(`$${price.output}/M out`);
  return bits.join(", ") + ".";
}

function describeCapabilities(provider, model) {
  const caps = getCapabilitiesForModel(provider, model) || {};
  const bits = [];
  if (caps.reasoning) bits.push("supports native reasoning");
  if (caps.contextWindow) bits.push(`${Math.round(caps.contextWindow / 1000)}k context`);
  if (caps.vision) bits.push("reads images");
  return bits.length ? bits.join(", ") + "." : "";
}

/**
 * Passthrough providers address a model with a vendor prefix baked in
 * ("anthropic/claude-haiku-4.5" under the `vercel` alias), and the table is keyed
 * by the bare id. Without this the lookup misses and the model silently falls to
 * the derived criteria — the one measured to decide 0/4 correctly.
 */
function vendorSuffix(id) {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : null;
}

function briefsFor(id) {
  if (!id) return null;
  return MODEL_BRIEFS[id] || null;
}

/** Versioned ids ("claude-sonnet-4-5-20250929") fall back to their family brief. */
function matchSuffix(table, id) {
  for (const key of Object.keys(table)) {
    if (key.length >= 8 && id.startsWith(key)) return table[key];
  }
  return null;
}

function truncateText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
