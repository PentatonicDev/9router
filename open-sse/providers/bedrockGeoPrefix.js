// Bedrock cross-region inference profile prefixes — the geo/routing segment
// that precedes the vendor id in a SYSTEM_DEFINED inference profile ("us.",
// "eu.", "global.", ...). Shared, dependency-free (no AWS SDK, no node:fs) so
// browser-bundled modules (capabilities.js, pricing.js — both reach the
// dashboard via client components) can strip it without pulling in
// open-sse/services/bedrockClient.js, which imports the AWS SDK.
export const BEDROCK_INFERENCE_PROFILE_PREFIXES = [
  "us-gov", "us", "eu", "apac", "global", "jp", "au", "ca", "sa", "me", "af",
];

// "us.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "anthropic.claude-sonnet-4-5-20250929-v1:0".
// Model ids without a geo prefix (or non-Bedrock ids) pass through unchanged.
export function stripBedrockGeoPrefix(model) {
  if (typeof model !== "string") return model;
  const firstSegment = model.split(".")[0];
  return BEDROCK_INFERENCE_PROFILE_PREFIXES.includes(firstSegment)
    ? model.slice(firstSegment.length + 1)
    : model;
}

// Vendor segment Bedrock model ids carry after the geo prefix (e.g. the
// "anthropic" in "anthropic.claude-opus-4-6-v1"). Matched literally rather
// than by the generic "any lowercase segment before a dot" shape, so a bare
// model name that happens to contain a dot (none do today, but pricing keys
// like "MiniMax-M2.5" already do) is never mistaken for a vendor prefix.
const BEDROCK_VENDOR_TOKENS = new Set([
  "anthropic", "openai", "amazon", "meta", "mistral", "deepseek", "qwen",
  "cohere", "moonshotai", "moonshot", "zai", "xai", "nvidia", "google",
  "writer", "minimax",
]);

function stripBedrockVendor(model) {
  const dot = model.indexOf(".");
  if (dot === -1) return model;
  const vendor = model.slice(0, dot);
  const rest = model.slice(dot + 1);
  if (rest && /^[a-z0-9-]+$/.test(vendor) && BEDROCK_VENDOR_TOKENS.has(vendor)) return rest;
  return model;
}

// Bedrock version suffixes: "-v1", "-v1:0" (inference-profile style) or
// "-1:0" (direct model-id style, e.g. "gpt-oss-120b-1:0").
function stripBedrockVersionSuffix(model) {
  return model.replace(/-v\d+(:\d+)?$/, "").replace(/-\d+:\d+$/, "");
}

// Reduce a Bedrock model id to the bare, provider-agnostic name that
// MODEL_PRICING / PATTERN_PRICING (and similar cross-provider tables) are
// keyed by: "global.anthropic.claude-opus-4-6-v1" -> "claude-opus-4-6",
// "openai.gpt-oss-120b-1:0" -> "gpt-oss-120b". Ids without a recognized
// vendor segment only get the version-suffix strip.
export function bedrockCanonicalModelName(model) {
  if (typeof model !== "string") return model;
  return stripBedrockVersionSuffix(stripBedrockVendor(stripBedrockGeoPrefix(model)));
}
