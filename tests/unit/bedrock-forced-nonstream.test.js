/**
 * Bedrock forces streaming end-to-end (ConverseStreamCommand is the only
 * upstream API) but a non-streaming client still calls /v1/chat/completions
 * without stream:true — handleForcedSSEToJson / parseSSEToOpenAIResponse then
 * has to turn the RAW re-encoded Bedrock event stream (BedrockExecutor just
 * mirrors ConverseStreamOutput 1:1 as `data: {json}\n\n`, no translation) into
 * a single chat.completion JSON.
 *
 * Before this fix, parseSSEToOpenAIResponse assumed every forced-stream
 * upstream already emitted OpenAI-shaped `choices[0].delta` chunks (true for
 * genuinely OpenAI-compatible providers and for kiro/commandcode, which
 * self-translate inside their own executor) — for Bedrock's raw
 * messageStart/contentBlockDelta/messageStop/metadata events, every line
 * failed the `choices` check silently, so the client got HTTP 200 with empty
 * content and no usage. Live-verified against the real model on
 * 127.0.0.1:20128 before the fix (empty content, usage: null).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const {
  handleForcedSSEToJson,
  parseSSEToOpenAIResponse
} = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// Mirrors BedrockExecutor's own re-encoding + its unconditional trailing [DONE].
function bedrockSSE(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

const MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

describe("parseSSEToOpenAIResponse(rawSSE, model, FORMATS.BEDROCK_CONVERSE)", () => {
  it("aggregates raw Bedrock Converse events into content + usage", () => {
    const raw = bedrockSSE([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { text: " 391" }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 2018, outputTokens: 140, totalTokens: 2158 } } },
    ]);

    const parsed = parseSSEToOpenAIResponse(raw, MODEL, FORMATS.BEDROCK_CONVERSE);
    expect(parsed.choices[0].message.content).toBe(" 391");
    expect(parsed.choices[0].finish_reason).toBe("stop");
    expect(parsed.usage).toEqual({ prompt_tokens: 2018, completion_tokens: 140, total_tokens: 2158 });
  });

  it("aggregates a tool call across contentBlockStart/Delta into message.tool_calls", () => {
    const raw = bedrockSSE([
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { start: { toolUse: { toolUseId: "tooluse_1", name: "get_weather" } }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { toolUse: { input: "{\"city\": \"P" } }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { toolUse: { input: "aris\"}" } }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 2571, outputTokens: 53, totalTokens: 2624 } } },
    ]);

    const parsed = parseSSEToOpenAIResponse(raw, MODEL, FORMATS.BEDROCK_CONVERSE);
    expect(parsed.choices[0].finish_reason).toBe("tool_calls");
    expect(parsed.choices[0].message.tool_calls).toEqual([
      { id: "tooluse_1", type: "function", function: { name: "get_weather", arguments: "{\"city\": \"Paris\"}" } },
    ]);
    expect(parsed.usage.total_tokens).toBe(2624);
  });

  it("still returns the raw {error} shape for the executor's re-encoded exception frame", () => {
    const raw = bedrockSSE([
      { messageStart: { role: "assistant" } },
      { error: { message: "Model context window exceeded" } },
    ]);
    expect(parseSSEToOpenAIResponse(raw, MODEL, FORMATS.BEDROCK_CONVERSE)).toEqual({
      error: { message: "Model context window exceeded" },
    });
  });

  it("leaves an already-OpenAI-shaped forced stream (e.g. kiro) untouched when no targetFormat is given", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "data: [DONE]",
    ].join("\n\n");
    const parsed = parseSSEToOpenAIResponse(raw, "kiro-model");
    expect(parsed.choices[0].message.content).toBe("hi");
    expect(parsed.usage.total_tokens).toBe(2);
  });
});

describe("handleForcedSSEToJson full path for Bedrock (targetFormat=bedrock-converse)", () => {
  function bedrockResponse(events) {
    const encoder = new TextEncoder();
    const raw = bedrockSSE(events);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }

  it("returns a chat.completion body with real content and usage, not an empty stub", async () => {
    const result = await handleForcedSSEToJson({
      providerResponse: bedrockResponse([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { delta: { text: "ok" }, contentBlockIndex: 0 } },
        { messageStop: { stopReason: "end_turn" } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
      ]),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.BEDROCK_CONVERSE,
      provider: "bedrock",
      model: MODEL,
      body: { model: MODEL, messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("ok");
    expect(json.usage.total_tokens).toBe(12);
  });
});
