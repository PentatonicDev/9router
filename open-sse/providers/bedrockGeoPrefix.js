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
