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

describe("USAGE_EXTRACTORS.bedrock", () => {
  it("maps Converse TokenUsage field names to a valid OpenAI usage object", () => {
    const usage = toOpenAIUsage({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 5,
    }, "bedrock");

    expect(usage.prompt_tokens).toBe(100);
    expect(usage.completion_tokens).toBe(40);
    expect(usage.total_tokens).toBe(140);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 20, cache_creation_tokens: 5 });
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
