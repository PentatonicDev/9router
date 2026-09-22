// Model criteria for the decision model (jev). The brief tells jev what each
// model is FOR so it can match task to model. Price never reaches this text —
// cost is the pool's ordering, applied in code after jev judges fitness.
//
// Resolution order: operator override → curated table → derived brief.
// The derived brief replaced an old capability-flag fallback that measured 0/4
// correct decisions; the tier-based derivation uses the same structured data
// (caps + pricing) to generate task-oriented text instead of raw flags.

import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { getPricingForModel } from "../providers/pricing.js";

// ── Curated briefs ──────────────────────────────────────────────────
// Override table for models where the derived brief isn't precise enough.
// Every entry here wins over derivation. Keep only the delta: if derivation
// already says the right thing, remove the entry.
export const MODEL_BRIEFS = {
  // Fable: derivation would say "frontier" but the brief needs the explicit
  // "reserve" framing to discourage jev from picking it casually.
  "claude-fable-5":
    "Most expensive and most capable. Reserve for long, ambiguous, high-stakes work where being wrong costs more than the tokens.",

  // DeepSeek: pricing is an outlier — all three cost $0.14/M but vary widely
  // in capability. Derivation would call them all "budget".
  "deepseek-flash":
    "Cheap and fast with native reasoning. Use for mechanical edits, formatting, lookups, and short commands. Good at code for its cost.",
  "deepseek-chat":
    "Cheap mid-range reasoning. Use for straightforward code work and multi-step tasks with clear requirements.",
  "deepseek-reasoner":
    "Cheap but strong reasoning. Use for harder debugging and multi-file work where the cheap model is not enough.",

  // Codex: code-tuned variants where the "tuned for code" qualifier matters
  // more than the price tier.
  "gpt-5.1-codex-mini":
    "Small and cheap, tuned for code. Use for localised code edits and mechanical changes; keep the context short.",
  "gpt-5.1-codex-max":
    "Expensive and tuned for code. Use for large, long-running coding tasks where depth matters more than cost.",
  "gpt-5.3-codex":
    "Code-tuned and mid-priced. Use for dense code editing and localised refactors with clear requirements.",
  "gpt-5.3-codex-spark":
    "Code-tuned and fast, but with a short context. Use for dense code editing and localised refactors; avoid tasks needing a lot of accumulated context.",
};

// ── Derived brief engine ────────────────────────────────────────────
// Inspired by LiteLLM's quality_tier (budget/mid/frontier) approach:
// classify models into cost tiers from their pricing, then generate
// task-oriented text from tier + capabilities.

// ponytail: tier boundaries are calibrated against Sep 2026 pricing.
// When a new price tier appears (e.g. sub-$0.10 or $20+), add a row.
// Upgrade: feed jev structured dimensions instead of text.
const TIERS = [
  { ceiling: 0.30,  label: "budget",   strength: "Cheapest and fastest",       use: "mechanical edits, formatting, lookups, renames, lint, and summarising", avoid: "Do NOT use for architecture, hard debugging, or multi-file refactors." },
  { ceiling: 1.50,  label: "low-mid",  strength: "Cheap and capable",          use: "straightforward implementation, medium-scope tasks, and multi-step work with clear requirements", avoid: null },
  { ceiling: 3.50,  label: "mid",      strength: "Balanced",                   use: "implementing features, writing tests, medium-scope refactors, and multi-file work with clear requirements", avoid: null },
  { ceiling: 6.00,  label: "high",     strength: "Strong reasoning",           use: "architecture, root-cause debugging of non-obvious bugs, race conditions, and design decisions with trade-offs", avoid: null },
  { ceiling: Infinity, label: "frontier", strength: "Most capable and expensive", use: "long, ambiguous, high-stakes work where being wrong costs more than the tokens", avoid: null },
];

function tierFor(inputPrice) {
  for (const tier of TIERS) {
    if (inputPrice <= tier.ceiling) return tier;
  }
  return TIERS[TIERS.length - 1];
}

function deriveBrief(provider, model) {
  const caps = getCapabilitiesForModel(provider, model) || {};
  const pricing = getPricingForModel(provider, model);
  const inputPrice = pricing?.input ?? null;

  if (inputPrice === null) return describeCapabilities(caps);

  const tier = tierFor(inputPrice);
  const parts = [tier.strength + "."];

  const family = modelFamily(model);
  if (family) parts.push(family + " family.");

  const extras = [];
  if (caps.reasoning) extras.push("native reasoning");
  if (caps.vision) extras.push("reads images");
  if (caps.search) extras.push("web search");
  if (caps.pdf) extras.push("reads PDFs");
  if (caps.audioInput) extras.push("audio input");
  if (caps.videoInput) extras.push("video input");
  if (caps.contextWindow) extras.push(`${Math.round(caps.contextWindow / 1000)}k context`);

  if (extras.length) parts.push("Supports " + extras.join(", ") + ".");

  parts.push("Use for " + tier.use + ".");
  if (tier.avoid) parts.push(tier.avoid);

  return parts.join(" ");
}

// Fallback for models with no pricing data at all
function describeCapabilities(caps) {
  const bits = [];
  if (caps.reasoning) bits.push("supports native reasoning");
  if (caps.contextWindow) bits.push(`${Math.round(caps.contextWindow / 1000)}k context`);
  if (caps.vision) bits.push("reads images");
  return bits.length ? bits.join(", ") + "." : "";
}

// ── Resolution ──────────────────────────────────────────────────────

export function resolveCriteria({ provider, model, briefs = {}, maxChars = 600 }) {
  const id = String(model || "");
  const override = briefs[`${provider}/${id}`] || briefs[id];
  const canonical = stripBedrockPrefix(id);
  const curated = MODEL_BRIEFS[id]
    || briefsFor(vendorSuffix(id))
    || (canonical !== id ? briefsFor(canonical) : null)
    || matchSuffix(MODEL_BRIEFS, canonical);
  return truncateText(override || curated || deriveBrief(provider, id), maxChars);
}

// ── Id normalization helpers ────────────────────────────────────────

// ponytail: static map, covers the models we route today. When a new vendor
// appears, add a row. Upgrade: derive from the provider registry.
const FAMILIES = [
  [/^claude-opus/,    "Anthropic Opus"],
  [/^claude-sonnet/,  "Anthropic Sonnet"],
  [/^claude-haiku/,   "Anthropic Haiku"],
  [/^claude-fable/,   "Anthropic Fable"],
  [/^gpt-5\.6-sol/,   "OpenAI Sol (frontier)"],
  [/^gpt-5\.6-terra/, "OpenAI Terra"],
  [/^gpt-5\.6-luna/,  "OpenAI Luna"],
  [/^gpt-5\./,        "OpenAI GPT"],
  [/^gpt-/,           "OpenAI GPT"],
  [/^o\d/,            "OpenAI o-series"],
  [/^deepseek-/,      "DeepSeek"],
  [/^glm-/,           "Zhipu GLM"],
  [/^gemini-/,        "Google Gemini"],
  [/^grok-/,          "xAI Grok"],
  [/^qwen/,           "Alibaba Qwen"],
  [/^kimi-/,          "Moonshot Kimi"],
];

function modelFamily(id) {
  const ids = [id];
  if (id.includes(".")) ids.push(id.split(".").pop());
  for (const candidate of ids) {
    for (const [re, name] of FAMILIES) {
      if (re.test(candidate)) return name;
    }
  }
  return null;
}

function vendorSuffix(id) {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : null;
}

function briefsFor(id) {
  if (!id) return null;
  return MODEL_BRIEFS[id] || MODEL_BRIEFS[stripBedrockPrefix(id)] || null;
}

function stripBedrockPrefix(id) {
  const parts = id.split(".");
  for (let i = 0; i < parts.length; i++) {
    const rest = parts.slice(i).join(".");
    if (MODEL_BRIEFS[rest]) return rest;
    const match = matchSuffix(MODEL_BRIEFS, rest);
    if (match !== null) return rest;
  }
  return id;
}

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
    if (/^\d+$/.test(part) || /^\d{8}$/.test(part) || /^v\d/.test(part) || part.includes(":")) break;
    result.push(part);
  }
  return result.join("-") || id;
}

function truncateText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
