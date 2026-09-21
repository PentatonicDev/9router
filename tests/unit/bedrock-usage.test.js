/**
 * BUG #4 regression test: the plan's first draft of USAGE_EXTRACTORS.bedrock
 * passed inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens straight
 * through to buildUsage(), which destructures promptTokens/completionTokens/
 * cachedTokens/cacheCreationTokens — none of those names match, so every field
 * except total_tokens (name collision) silently became undefined/0.
 *
 * This test pins the field names buildUsage() actually expects, so a future
 * edit that reintroduces the mismatch fails loudly here instead of shipping
 * prompt_tokens: undefined to every Bedrock request.
 */
import { describe, it, expect } from "vitest";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { calculateCostFromTokens } from "../../open-sse/providers/pricing.js";

describe("USAGE_EXTRACTORS.bedrock", () => {
  it("maps Converse TokenUsage field names to a valid OpenAI usage object, folding cache into prompt_tokens", () => {
    const usage = toOpenAIUsage({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 5,
    }, "bedrock");

    // inputTokens excludes cache (measured Converse semantics) — prompt_tokens
    // must fold cacheRead + cacheWrite in, same as the claude extractor.
    expect(usage.prompt_tokens).toBe(125);
    expect(usage.completion_tokens).toBe(40);
    expect(usage.total_tokens).toBe(140);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 20, cache_creation_tokens: 5 });
  });

  it("folds cache into prompt_tokens for a real cached-request round-trip (measured round 2)", () => {
    const usage = toOpenAIUsage({
      inputTokens: 15,
      outputTokens: 4,
      totalTokens: 32377,
      cacheReadInputTokens: 32358,
      cacheWriteInputTokens: 0,
    }, "bedrock");

    expect(usage.prompt_tokens).toBe(32373);
    expect(usage.total_tokens).toBe(32377);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 32358 });
  });

  it("produces a cost equal to the uncached tokens at input rate + cache at its own rate (measured round 1 and round 2)", () => {
    const pricing = { input: 1, output: 5, cached: 0.1, cache_creation: 1.25 };

    const round1 = canonicalizeUsage(toOpenAIUsage({
      inputTokens: 15, outputTokens: 5, totalTokens: 32378,
      cacheReadInputTokens: 0, cacheWriteInputTokens: 32358,
    }, "bedrock"));
    const cost1 = calculateCostFromTokens(round1, pricing);
    expect(cost1).toBeCloseTo((15 * 1 + 32358 * 1.25 + 5 * 5) * 1e-6, 12);

    const round2 = canonicalizeUsage(toOpenAIUsage({
      inputTokens: 15, outputTokens: 4, totalTokens: 32377,
      cacheReadInputTokens: 32358, cacheWriteInputTokens: 0,
    }, "bedrock"));
    const cost2 = calculateCostFromTokens(round2, pricing);
    expect(cost2).toBeCloseTo(15 * 1e-6 * 1 + 32358 * 1e-6 * 0.1 + 4 * 1e-6 * 5, 12);
  });

  it("does not silently produce undefined prompt/completion tokens (the exact BUG #4 symptom)", () => {
    const usage = toOpenAIUsage({ inputTokens: 7, outputTokens: 3, totalTokens: 10 }, "bedrock");
    expect(usage.prompt_tokens).not.toBeUndefined();
    expect(usage.completion_tokens).not.toBeUndefined();
    expect(usage.prompt_tokens).toBe(7);
    expect(usage.completion_tokens).toBe(3);
  });

  it("falls back to input+output when totalTokens is absent", () => {
    const usage = toOpenAIUsage({ inputTokens: 7, outputTokens: 3 }, "bedrock");
    expect(usage.total_tokens).toBe(10);
  });

  it("omits cache detail fields when both are zero (matches buildUsage's > 0 gate)", () => {
    const usage = toOpenAIUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, "bedrock");
    expect(usage.prompt_tokens_details).toBeUndefined();
  });
});
