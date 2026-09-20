/**
 * Claude extended thinking on Bedrock Converse — request-side (applyThinking /
 * translateRequest) and response-side (reasoningContent → reasoning_content) wiring.
 * See open-sse/translator/concerns/thinkingUnified.js ("bedrock-converse" format) and
 * open-sse/translator/response/bedrock-converse-to-openai.js.
 */
import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { bedrockConverseToOpenAIResponse } from "../../open-sse/translator/response/bedrock-converse-to-openai.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const SONNET = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const OPUS_41 = "anthropic.claude-opus-4-1-20250805-v1:0"; // maxOutput 32000 (tighter ceiling)

describe("capabilities/thinkingLevels: Claude-on-Bedrock ids get reasoning", () => {
  it("reasoning:true and bedrock-converse thinkingFormat for the four Anthropic ids", () => {
    for (const id of [
      "anthropic.claude-opus-4-1-20250805-v1:0",
      "anthropic.claude-opus-4-5-20251101-v1:0",
      SONNET,
      "anthropic.claude-haiku-4-5-20251001-v1:0",
    ]) {
      const caps = getCapabilitiesForModel("bedrock", id);
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingFormat).toBe("bedrock-converse");
    }
  });

  it("non-Anthropic Bedrock models stay non-reasoning", () => {
    expect(getCapabilitiesForModel("bedrock", "amazon.nova-pro-v1:0").reasoning).toBe(false);
  });

  it("getThinkingLevels matches the Claude direct provider's budget level set", () => {
    expect(getThinkingLevels("bedrock", SONNET)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("applyThinking('bedrock-converse'): additionalModelRequestFields.thinking", () => {
  it("a level maps to budget_tokens under additionalModelRequestFields.thinking", () => {
    const body = { inferenceConfig: { maxTokens: 4096 } };
    applyThinking(FORMATS.BEDROCK_CONVERSE, SONNET, body, "bedrock", { mode: "level", level: "high" });
    expect(body.additionalModelRequestFields.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
  });

  it("none clears the thinking field instead of sending type:enabled", () => {
    const body = { inferenceConfig: { maxTokens: 4096 }, additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 8192 } } };
    applyThinking(FORMATS.BEDROCK_CONVERSE, SONNET, body, "bedrock", { mode: "none" });
    expect(body.additionalModelRequestFields.thinking).toBeUndefined();
  });

  it("auto mode enables thinking without a budget_tokens field", () => {
    const body = { inferenceConfig: { maxTokens: 4096 } };
    applyThinking(FORMATS.BEDROCK_CONVERSE, SONNET, body, "bedrock", { mode: "auto" });
    expect(body.additionalModelRequestFields.thinking).toEqual({ type: "enabled" });
  });

  it("raises inferenceConfig.maxTokens above budget_tokens when it would otherwise be <=", () => {
    const body = { inferenceConfig: { maxTokens: 2000 } };
    applyThinking(FORMATS.BEDROCK_CONVERSE, SONNET, body, "bedrock", { mode: "level", level: "high" }); // budget 24576
    expect(body.inferenceConfig.maxTokens).toBeGreaterThan(body.additionalModelRequestFields.thinking.budget_tokens);
  });

  it("shrinks budget_tokens instead of exceeding the model's maxOutput ceiling", () => {
    // Opus 4.1 ceiling is 32000; "max" level budget (128000) would blow past it.
    const body = { inferenceConfig: { maxTokens: 2000 } };
    applyThinking(FORMATS.BEDROCK_CONVERSE, OPUS_41, body, "bedrock", { mode: "level", level: "max" });
    expect(body.inferenceConfig.maxTokens).toBeLessThanOrEqual(32000);
    expect(body.additionalModelRequestFields.thinking.budget_tokens).toBeLessThan(body.inferenceConfig.maxTokens);
  });

  it("a non-reasoning Bedrock model strips any stray thinking fields instead of applying them", () => {
    const body = { inferenceConfig: { maxTokens: 4096 }, thinking: { type: "enabled", budget_tokens: 8192 } };
    applyThinking(FORMATS.BEDROCK_CONVERSE, "amazon.nova-pro-v1:0", body, "bedrock", { mode: "level", level: "high" });
    expect(body.additionalModelRequestFields).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
});

describe("translateRequest: openai → bedrock-converse keeps additionalModelRequestFields set by the thinking step", () => {
  it("a client reasoning_effort survives translation + thinking application", () => {
    const body = {
      model: SONNET,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "medium",
      max_tokens: 1024,
    };
    const out = translateRequest(FORMATS.OPENAI, FORMATS.BEDROCK_CONVERSE, SONNET, body, false, null, "bedrock");
    expect(out.additionalModelRequestFields.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    // messages/system from the request translator must survive untouched.
    expect(out.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
    expect(out.inferenceConfig.maxTokens).toBeGreaterThan(8192);
  });

  it("combo maxThinkingLevel clamps the effective level the same way as other targets", () => {
    const body = {
      model: SONNET,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "xhigh",
    };
    const out = translateRequest(
      FORMATS.OPENAI, FORMATS.BEDROCK_CONVERSE, SONNET, body,
      false, null, "bedrock", null, [], null, null, "high"
    );
    // xhigh (32768) clamped to high (24576), not the raw xhigh budget.
    expect(out.additionalModelRequestFields.thinking.budget_tokens).toBe(24576);
  });
});

describe("bedrock-converse-to-openai: reasoningContent → OpenAI reasoning_content delta", () => {
  function feed(events) {
    const state = { model: SONNET };
    const chunks = [];
    for (const e of events) {
      const out = bedrockConverseToOpenAIResponse(e, state);
      if (out) chunks.push(out);
    }
    return chunks;
  }

  it("reasoningContent.text streams as a reasoning_content delta", () => {
    const chunks = feed([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { reasoningContent: { text: "Let me think" } }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { reasoningContent: { text: "..." } }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
    ]);
    expect(chunks[1].choices[0].delta.reasoning_content).toBe("Let me think");
    expect(chunks[2].choices[0].delta.reasoning_content).toBe("...");
    // Never leaks into the plain-text `content` field a client-visible answer uses.
    expect(chunks[1].choices[0].delta.content).toBeUndefined();
  });

  it("a redactedContent-only reasoningContent delta produces no chunk (no client-visible text)", () => {
    const chunks = feed([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { reasoningContent: { redactedContent: "b64==" } }, contentBlockIndex: 0 } },
    ]);
    expect(chunks).toHaveLength(1); // only messageStart's role chunk
  });

  it("a signature-only reasoningContent delta produces no chunk", () => {
    const chunks = feed([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { reasoningContent: { signature: "sig-abc" } }, contentBlockIndex: 0 } },
    ]);
    expect(chunks).toHaveLength(1);
  });

  it("reasoning and answer text interleave on separate content blocks without cross-contamination", () => {
    const chunks = feed([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { reasoningContent: { text: "thinking" } }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { text: "answer" }, contentBlockIndex: 1 } },
    ]);
    expect(chunks[1].choices[0].delta.reasoning_content).toBe("thinking");
    expect(chunks[2].choices[0].delta.content).toBe("answer");
    expect(chunks[2].choices[0].delta.reasoning_content).toBeUndefined();
  });
});
