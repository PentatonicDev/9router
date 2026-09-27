import { describe, expect, it } from "vitest";

import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Claude Code talks to a claude/anthropic provider over the native passthrough path
// (see open-sse/utils/clientDetector.js isNativePassthrough), so its SSE never goes
// through the translate branch that accumulates content_block_delta. These tests pin
// what onStreamComplete receives — the text the stored request detail shows as
// "Client Response (Final)" in the dashboard.
async function runPassthrough(lines, { provider = "anthropic", target = null, source = null } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n")));
      controller.close();
    },
  });

  let seen = null;
  const onComplete = (contentObj, usage, ttftAt, firstContentAt, upstream) => {
    seen = { contentObj, usage, ttftAt, firstContentAt, upstream };
  };
  const transform = target
    ? createSSETransformStreamWithLogger(target, source, provider, null, null, "model", "conn", {}, onComplete)
    : createPassthroughStreamWithLogger(provider, null, "claude-sonnet-4-5", "conn", {}, onComplete);

  const output = stream.pipeThrough(transform);
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, ...seen };
}

function claudeEvent(type, data) {
  return [`event: ${type}`, `data: ${JSON.stringify(data)}`, ""];
}

describe("Claude-native passthrough accumulates assistant text", () => {
  it("returns the concatenated content_block_delta text, not an empty string", async () => {
    const { contentObj } = await runPassthrough([
      ...claudeEvent("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 12, output_tokens: 0 } } }),
      ...claudeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ...claudeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      ...claudeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
      ...claudeEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      ...claudeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      ...claudeEvent("message_stop", { type: "message_stop" }),
    ]);

    expect(contentObj.content).toBe("Hello world");
  });

  it("separates thinking deltas from text deltas", async () => {
    const { contentObj } = await runPassthrough([
      ...claudeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      ...claudeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "weighing options" } }),
      ...claudeEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      ...claudeEvent("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
      ...claudeEvent("message_stop", { type: "message_stop" }),
    ]);

    expect(contentObj.content).toBe("answer");
    expect(contentObj.thinking).toBe("weighing options");
  });

  it("reports a tool-only turn as non-empty output so it is not labelled empty", async () => {
    const { contentObj } = await runPassthrough([
      ...claudeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } }),
      ...claudeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
      ...claudeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"/tmp"}' } }),
      ...claudeEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      ...claudeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
      ...claudeEvent("message_stop", { type: "message_stop" }),
    ]);

    expect(contentObj.content).toBe("");
    expect(contentObj.toolCalls).toBe(1);
  });

  it("forwards the upstream bytes untouched", async () => {
    const { text } = await runPassthrough([
      ...claudeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      ...claudeEvent("message_stop", { type: "message_stop" }),
    ]);

    expect(text).toContain("event: content_block_delta");
    expect(text).toContain('"text":"hi"');
    expect(text).toContain("event: message_stop");
  });
});

describe("OpenAI-shaped passthrough preserves output", () => {
  it("still accumulates choices[0].delta.content and reasoning_content", async () => {
    const { contentObj, text } = await runPassthrough([
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "ok" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "",
      "data: [DONE]",
      "",
    ], { provider: "deepseek" });

    expect(contentObj.content).toBe("ok");
    expect(contentObj.thinking).toBe("hmm");
    expect(text).toContain("data: [DONE]");
  });

  it("accumulates Responses-native output_text delta in passthrough", async () => {
    const { contentObj } = await runPassthrough([
      ...claudeEvent("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      ...claudeEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "par" }),
      ...claudeEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "tial" }),
      ...claudeEvent("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 4, output_tokens: 2 } } }),
    ], { provider: "codex" });

    expect(contentObj.content).toBe("partial");
  });
});

describe("translated output accumulation", () => {
  it("records Responses text and tool turns on the OpenAI client pivot", async () => {
    const { contentObj, text } = await runPassthrough([
      ...claudeEvent("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      ...claudeEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "partial" }),
      ...claudeEvent("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "search" } }),
      ...claudeEvent("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed" } }),
    ], { provider: "codex", target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI });
    expect(text).toContain("data: [DONE]");
    expect(contentObj).toMatchObject({ content: "partial", toolCalls: 1 });
  });

  it("stores translated Responses reasoning summary as thinking", async () => {
    const { contentObj, text } = await runPassthrough([
      ...claudeEvent("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      ...claudeEvent("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "reason" }),
      ...claudeEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "answer" }),
      ...claudeEvent("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed" } }),
    ], { provider: "codex", target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI });
    expect(text).toContain('"reasoning_content":"reason"');
    expect(contentObj).toMatchObject({ content: "answer", thinking: "reason" });
  });

  it("counts one OpenAI tool across repeated fragments, not every delta", async () => {
    const delta = (tool_calls) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { tool_calls } }] })}`;
    const { contentObj } = await runPassthrough([
      delta([{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } }]), "",
      delta([{ index: 0, function: { arguments: '{"q":' } }]), "",
      delta([{ index: 0, function: { arguments: '"hi"}' } }]), "",
      "data: [DONE]", "",
    ], { provider: "openai" });
    expect(contentObj.toolCalls).toBe(1);
  });
});

describe("stream tail without a final newline", () => {
  it("records Claude passthrough text in the final event", async () => {
    const event = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "last" } })}`;
    const { contentObj, text } = await runPassthrough([event]);
    expect(contentObj.content).toBe("last");
    expect(text).toContain('"text":"last"');
  });

  it("records Responses text in the final translated event", async () => {
    const event = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "last" })}`;
    const { contentObj } = await runPassthrough([event], { provider: "codex", target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI });
    expect(contentObj.content).toBe("last");
  });

  it("appends [DONE] after a final Responses terminal translated to OpenAI", async () => {
    const event = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`;
    const { text, upstream } = await runPassthrough([event], { provider: "codex", target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI });
    expect(text).toContain("data: [DONE]\n\n");
    expect(upstream.terminal_event).toBe("response.completed");
  });

  it("keeps a final Responses success terminal instead of synthesizing a failure", async () => {
    const event = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`;
    const { text, upstream } = await runPassthrough([event], { provider: "codex", target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI_RESPONSES });
    expect(text).toContain("event: response.completed\n");
    expect(text).not.toContain("response.failed");
    expect(upstream.terminal_event).toBe("response.completed");
  });
});

describe("Gemini response accumulation", () => {
  it.each([false, true])("records text, thinking and tools from wrapped=%s chunks", async (wrapped) => {
    const chunk = { candidates: [{ content: { parts: [{ text: "reason", thought: true }, { text: "answer" }, { functionCall: { name: "search" } }] } }] };
    const { contentObj, firstContentAt } = await runPassthrough([`data: ${JSON.stringify(wrapped ? { response: chunk } : chunk)}`, ""], { provider: "gemini" });
    expect(contentObj).toMatchObject({ content: "answer", thinking: "reason", toolCalls: 1 });
    expect(firstContentAt).toEqual(expect.any(Number));
  });
});

describe("provider-native translated output accumulation", () => {
  it.each([FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY])("records %s text, thinking and tools after translation", async (target) => {
    const response = { candidates: [{ content: { parts: [
      { text: "reason", thought: true }, { text: "answer" }, { functionCall: { name: "search", args: { q: "hi" } } },
    ] } }] };
    const { contentObj, text } = await runPassthrough([`data: ${JSON.stringify({ response })}`, ""], {
      provider: target, target, source: FORMATS.OPENAI,
    });
    expect(text).toContain('"content":"answer"');
    expect(contentObj).toMatchObject({ content: "answer", thinking: "reason", toolCalls: 1 });
  });

  it("records Bedrock Converse text, thinking and one tool call", async () => {
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "reason" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "answer" } } },
      { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tool_1", name: "search" } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"q":"hi"}' } } } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 3 } } },
    ];
    const { contentObj, text } = await runPassthrough(events.flatMap(event => [`data: ${JSON.stringify(event)}`, ""]), {
      provider: "bedrock", target: FORMATS.BEDROCK_CONVERSE, source: FORMATS.OPENAI,
    });

    expect(text).toContain('"content":"answer"');
    expect(contentObj).toMatchObject({ content: "answer", thinking: "reason", toolCalls: 1 });
  });

  it("records Ollama NDJSON text, thinking and one tool call", async () => {
    const events = [
      { model: "local", message: { role: "assistant", thinking: "reason", content: "" }, done: false },
      { model: "local", message: { role: "assistant", content: "answer" }, done: false },
      { model: "local", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "search", arguments: { q: "hi" } } }] }, done: false },
      { model: "local", done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 3 },
    ];
    const { contentObj, text } = await runPassthrough(events.map(JSON.stringify), {
      provider: "ollama", target: FORMATS.OLLAMA, source: FORMATS.OPENAI,
    });

    expect(text).toContain('"content":"answer"');
    expect(contentObj).toMatchObject({ content: "answer", thinking: "reason", toolCalls: 1 });
  });
});

describe("accumulation is bounded", () => {
  it("caps stored content and flags the truncation", async () => {
    const chunk = "x".repeat(4096);
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(...claudeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }));
    }
    lines.push(...claudeEvent("message_stop", { type: "message_stop" }));

    const { contentObj } = await runPassthrough(lines);

    expect(contentObj.content.length).toBeLessThan(40 * 4096);
    expect(contentObj.truncated).toBe(true);
  });
});
