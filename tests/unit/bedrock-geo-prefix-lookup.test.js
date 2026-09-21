/**
 * Real requests carry the Bedrock inference-profile id ("us.anthropic.claude-
 * sonnet-4-5-...", "global.anthropic...") — not the bare vendor id the
 * capabilities/pricing tables are keyed by. Before this fix, neither
 * getCapabilitiesForModel nor getPricingForModel stripped that prefix, so a
 * live request silently fell through to the generic Claude pattern match
 * (wrong thinkingFormat "claude-budget" instead of "bedrock-converse", wrong
 * contextWindow/maxOutput) and to $0 pricing. See open-sse/providers/
 * bedrockGeoPrefix.js.
 */
import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { stripBedrockGeoPrefix } from "../../open-sse/providers/bedrockGeoPrefix.js";
import { BEDROCK_PRICING } from "../../open-sse/providers/bedrockPricing.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const BARE = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const US_PREFIXED = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const GLOBAL_PREFIXED = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";

describe("stripBedrockGeoPrefix", () => {
  it("strips a known geo prefix and leaves other ids untouched", () => {
    expect(stripBedrockGeoPrefix(US_PREFIXED)).toBe(BARE);
    expect(stripBedrockGeoPrefix(GLOBAL_PREFIXED)).toBe(BARE);
    expect(stripBedrockGeoPrefix(BARE)).toBe(BARE);
    expect(stripBedrockGeoPrefix("amazon.nova-pro-v1:0")).toBe("amazon.nova-pro-v1:0");
  });
});

describe("getCapabilitiesForModel('bedrock', <inference-profile id>)", () => {
  for (const [label, id] of [["us.-prefixed", US_PREFIXED], ["global.-prefixed", GLOBAL_PREFIXED]]) {
    it(`resolves the ${label} id to the same capabilities as the bare id`, () => {
      const prefixed = getCapabilitiesForModel("bedrock", id);
      const bare = getCapabilitiesForModel("bedrock", BARE);
      expect(prefixed).toEqual(bare);
      // Pinned explicitly: this is exactly what regressed (fell through to the
      // generic "claude-sonnet-*" pattern match instead of the bedrock table entry).
      expect(prefixed.thinkingFormat).toBe("bedrock-converse");
      expect(prefixed.contextWindow).toBe(1000000);
      expect(prefixed.maxOutput).toBe(128000);
    });
  }

  it("getThinkingLevels resolves for the prefixed id the same as the bare id", () => {
    expect(getThinkingLevels("bedrock", US_PREFIXED)).toEqual(getThinkingLevels("bedrock", BARE));
  });
});

describe("getPricingForModel('bedrock', <inference-profile id>)", () => {
  for (const [label, id] of [["us.-prefixed", US_PREFIXED], ["global.-prefixed", GLOBAL_PREFIXED]]) {
    it(`resolves the ${label} id to non-zero pricing (exact id first, then the bare id)`, () => {
      const prefixed = getPricingForModel("bedrock", id);
      const bare = getPricingForModel("bedrock", BARE);
      // Regional profiles are billed above the bare id; "global." matches it.
      expect(prefixed).toEqual(BEDROCK_PRICING[id] || bare);
      expect(prefixed.input).toBeGreaterThan(0);
      expect(prefixed.output).toBeGreaterThan(0);
    });
  }
});

describe("applyThinking('bedrock-converse') with the prefixed model id", () => {
  it("sets additionalModelRequestFields.thinking for a us.-prefixed model (previously stripped as non-reasoning)", () => {
    const body = { inferenceConfig: { maxTokens: 4096 } };
    applyThinking(FORMATS.BEDROCK_CONVERSE, US_PREFIXED, body, "bedrock", { mode: "level", level: "high" });
    expect(body.additionalModelRequestFields?.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
  });
});
