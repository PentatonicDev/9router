/**
 * PROVIDER_PRICING.bedrock only lists a handful of hand-picked ids, but the
 * account's Bedrock discovery surfaces dozens more (Anthropic point releases,
 * OpenAI, Minimax, Kimi, GLM, Grok, ...). bedrockCanonicalModelName() strips
 * the geo prefix, vendor segment and version suffix so those ids can hit the
 * provider-agnostic MODEL_PRICING / PATTERN_PRICING tables instead of falling
 * through to $0 cost. See open-sse/providers/bedrockGeoPrefix.js.
 */
import { describe, it, expect } from "vitest";
import { bedrockCanonicalModelName } from "../../open-sse/providers/bedrockGeoPrefix.js";
import { getPricingForModel, MODEL_PRICING } from "../../open-sse/providers/pricing.js";
import { BEDROCK_PRICING } from "../../open-sse/providers/bedrockPricing.js";

describe("bedrockCanonicalModelName", () => {
  const cases = [
    ["global.anthropic.claude-opus-4-6-v1", "claude-opus-4-6"],
    ["openai.gpt-oss-120b-1:0", "gpt-oss-120b"],
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929"],
    ["us.anthropic.claude-sonnet-5", "claude-sonnet-5"],
    ["global.anthropic.claude-fable-5-1", "claude-fable-5-1"],
    ["us.openai.gpt-5.6-terra", "gpt-5.6-terra"],
    ["us.openai.gpt-6-astra", "gpt-6-astra"],
    ["minimax.minimax-m2", "minimax-m2"],
    ["global.moonshotai.kimi-k3", "kimi-k3"],
    ["zai.glm-5", "glm-5"],
    ["us.xai.grok-4.6", "grok-4.6"],
    // "amazon" is itself a recognized vendor token, so both strips apply.
    ["amazon.nova-pro-v1:0", "nova-pro"],
    // uppercase segment ("MiniMax") never matches the vendor regex, so this
    // passes through untouched rather than being mistaken for a vendor prefix.
    ["MiniMax-M2.5", "MiniMax-M2.5"],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => {
      expect(bedrockCanonicalModelName(input)).toBe(expected);
    });
  }
});

describe("getPricingForModel('bedrock') — exact id before the stripped id", () => {
  it("bills a regional profile above the bare id and 'global.' like the bare id", () => {
    expect(getPricingForModel("bedrock", "anthropic.claude-sonnet-5").input).toBe(2);
    expect(getPricingForModel("bedrock", "us.anthropic.claude-sonnet-5").input).toBe(2.2);
    expect(getPricingForModel("bedrock", "global.anthropic.claude-opus-4-6-v1")).toEqual({ input: 5, output: 25, cached: 0.5, cache_creation: 6.25 });
    expect(getPricingForModel("bedrock", "us.anthropic.claude-opus-4-6-v1").input).toBe(5.5);
  });
});

describe("getPricingForModel('bedrock', ...) with canonical fallback", () => {
  it("resolves an id models.dev does not list yet through the canonical pattern tables", () => {
    expect(BEDROCK_PRICING["global.moonshotai.kimi-k3"]).toBeUndefined();
    expect(getPricingForModel("bedrock", "global.moonshotai.kimi-k3")).toEqual(getPricingForModel("kimi", "kimi-k3"));
    expect(MODEL_PRICING["kimi-k3"]).toBeDefined();
  });

  it("resolves an unlisted OpenAI-on-Bedrock id", () => {
    expect(getPricingForModel("bedrock", "us.openai.gpt-5.6-terra")).not.toBeNull();
  });

  it("still prefers the PROVIDER_PRICING.bedrock entry over canonicalization (step 1 wins)", () => {
    const direct = getPricingForModel("bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(direct).toBe(BEDROCK_PRICING["anthropic.claude-haiku-4-5-20251001-v1:0"]);
    expect(direct).toEqual({ input: 1, output: 5, cached: 0.1, cache_creation: 1.25 });
  });

  it("does not false-positive an unpriced Llama id just because it has a recognized vendor prefix", () => {
    expect(getPricingForModel("bedrock", "meta.llama3-8b-instruct-v1:0")).toBeNull();
  });

  it("leaves non-bedrock providers' resolution untouched (no canonicalization applied)", () => {
    // The canonical-name fallback is gated on provider === "bedrock"; for any
    // other provider this id was null before this change and still is.
    expect(getPricingForModel("kiro", "anthropic.claude-opus-4-6-v1")).toBeNull();
  });
});
