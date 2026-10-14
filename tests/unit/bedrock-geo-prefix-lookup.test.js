// Real requests carry the Bedrock inference-profile id ("us.anthropic...",
// "global.anthropic..."); pricing must resolve it to the bare id's rates.
import { describe, it, expect } from "vitest";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { stripBedrockGeoPrefix } from "../../open-sse/providers/bedrockGeoPrefix.js";
import { BEDROCK_PRICING } from "../../open-sse/providers/bedrockPricing.js";

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

