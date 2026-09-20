/**
 * Unit tests for open-sse/translator/response/bedrock-converse-to-openai.js
 *
 * Each `chunk` is one already-parsed Bedrock ConverseStreamOutput event (the
 * executor JSON-encodes the SDK's async-iterable 1:1; utils/stream.js JSON.parses
 * it back before calling this translator), so events are fed as plain objects.
 */
import { describe, it, expect } from "vitest";
import { bedrockConverseToOpenAIResponse } from "../../open-sse/translator/response/bedrock-converse-to-openai.js";

function feed(events, model) {
  const state = { model };
  const chunks = [];
  for (const e of events) {
    const out = bedrockConverseToOpenAIResponse(e, state);
    if (out) chunks.push(out);
  }
  return { state, chunks };
}

describe("bedrock-converse-to-openai — text streaming", () => {
  it("emits role on messageStart, content on contentBlockDelta text, finish+usage on metadata", () => {
    const { chunks, state } = feed([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { text: "Hello" }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { text: " world" }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } } },
    ], "anthropic.claude-sonnet-4-5-20250929-v1:0");

    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[1].choices[0].delta.content).toBe("Hello");
    expect(chunks[2].choices[0].delta.content).toBe(" world");
    const final = chunks.at(-1);
    expect(final.choices[0].finish_reason).toBe("stop");
    expect(final.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    expect(state.usage).toBe(final.usage); // read by utils/stream.js finalizeStream()
  });
});

describe("bedrock-converse-to-openai — tool call assembled across fragments", () => {
  it("opens a tool_call on contentBlockStart and accumulates arguments across deltas", () => {
    const { chunks } = feed([
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { start: { toolUse: { toolUseId: "call_1", name: "get_weather" } }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { toolUse: { input: '{"city":' } }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { toolUse: { input: '"SP"}' } }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
    ]);

    const startTc = chunks[1].choices[0].delta.tool_calls[0];
    expect(startTc).toEqual({ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } });
    expect(chunks[2].choices[0].delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: '{"city":' } });
    expect(chunks[3].choices[0].delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: '"SP"}' } });

    const assembled = chunks[2].choices[0].delta.tool_calls[0].function.arguments
      + chunks[3].choices[0].delta.tool_calls[0].function.arguments;
    expect(JSON.parse(assembled)).toEqual({ city: "SP" });

    const final = chunks.at(-1);
    expect(final.choices[0].finish_reason).toBe("tool_calls");
  });

  it("keys parallel tool calls by contentBlockIndex, not stream order", () => {
    const { chunks } = feed([
      { contentBlockStart: { start: { toolUse: { toolUseId: "a", name: "fnA" } }, contentBlockIndex: 0 } },
      { contentBlockStart: { start: { toolUse: { toolUseId: "b", name: "fnB" } }, contentBlockIndex: 1 } },
      { contentBlockDelta: { delta: { toolUse: { input: "1" } }, contentBlockIndex: 1 } },
      { contentBlockDelta: { delta: { toolUse: { input: "2" } }, contentBlockIndex: 0 } },
    ]);
    // block 1 (fnB, tool index 1) delta arrives before block 0 (fnA, tool index 0)'s delta
    expect(chunks[2].choices[0].delta.tool_calls[0]).toEqual({ index: 1, function: { arguments: "1" } });
    expect(chunks[3].choices[0].delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: "2" } });
  });
});

describe("bedrock-converse-to-openai — StopReason fallback (BUG #5)", () => {
  it.each([
    ["end_turn", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
    ["stop_sequence", "stop"],
    ["content_filtered", "content_filter"],
    ["guardrail_intervened", "stop"],
    ["malformed_model_output", "stop"],
    ["malformed_tool_use", "stop"],
    ["model_context_window_exceeded", "stop"],
  ])("maps stopReason %s -> finish_reason %s", (stopReason, expected) => {
    const { chunks } = feed([
      { messageStop: { stopReason } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
    ]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe(expected);
  });
});

describe("bedrock-converse-to-openai — mid-stream exception events", () => {
  // The executor (open-sse/executors/bedrock.js) re-encodes an inline
  // exception event as a `chunk.error` frame before it ever reaches this
  // translator, and the generic stream pipeline's extractStreamError() acts
  // on that raw chunk before translateResponse() is called at all — so this
  // function is never handed an exception-keyed chunk on the real path.
  // Ignoring it here (not throwing) is the defensive fallback: throwing would
  // abort the ReadableStream with zero error content delivered to the client
  // if that upstream invariant were ever broken.
  it("ignores an exception-keyed chunk rather than throwing", () => {
    const state = {};
    expect(bedrockConverseToOpenAIResponse({ throttlingException: { message: "too fast" } }, state))
      .toBeNull();
  });
});
