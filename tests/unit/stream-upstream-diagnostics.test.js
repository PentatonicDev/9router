import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

// Feeds a synthetic Responses-API SSE stream through the OPENAI_RESPONSES -> OPENAI
// pivot (the shape a chat-completions client sees when talking to Codex) and
// captures both the bytes the client received and the onStreamComplete diagnostics
// that feed the stored request detail (see open-sse/utils/stream.js buildUpstreamSummary).
async function runTransform(lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n")));
      controller.close();
    },
  });

  let upstream = null;
  const transform = createSSETransformStreamWithLogger(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI,
    "codex",
    null,
    null,
    "gpt-5.5",
    "conn",
    {},
    (content, usage, ttftAt, firstContentAt, upstreamArg) => { upstream = upstreamArg; },
  );

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
  return { text, upstream };
}

function sseEvent(type, data) {
  return [`event: ${type}`, `data: ${JSON.stringify(data)}`, ""];
}

describe("Responses upstream diagnostics on the pivot to a chat-completions client", () => {
  it("surfaces response.incomplete as finish_reason length, followed by [DONE]", async () => {
    const { text, upstream } = await runTransform([
      ...sseEvent("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      ...sseEvent("response.in_progress", { type: "response.in_progress", response: { id: "resp_1", status: "in_progress" } }),
      ...sseEvent("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning" } }),
      ...sseEvent("response.incomplete", {
        type: "response.incomplete",
        response: {
          id: "resp_1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
    ]);

    const doneIndex = text.indexOf("data: [DONE]");
    expect(doneIndex).toBeGreaterThan(-1);
    const chunkLine = text.slice(0, doneIndex).trim().split("\n").pop();
    const chunk = JSON.parse(chunkLine.slice("data: ".length));
    expect(chunk.choices[0].finish_reason).toBe("length");

    expect(upstream.terminal_event).toBe("response.incomplete");
    expect(upstream.response_status).toBe("incomplete");
    expect(upstream.incomplete_reason).toBe("max_output_tokens");
    expect(upstream.output_items).toEqual({ reasoning: 1 });
    expect(upstream.errored).toBe(false);
  });

  it("surfaces response.failed as an error frame with upstream.error set", async () => {
    const { text, upstream } = await runTransform([
      ...sseEvent("response.created", { type: "response.created", response: { id: "resp_2", status: "in_progress" } }),
      ...sseEvent("response.failed", {
        type: "response.failed",
        response: { id: "resp_2", status: "failed", error: { message: "model overloaded", type: "server_error" } },
      }),
    ]);

    expect(text).toContain('"error"');
    expect(upstream.terminal_event).toBe("response.failed");
    expect(upstream.error).toBe("model overloaded");
    expect(upstream.errored).toBe(true);
  });

  it("keeps finish_reason stop and terminal_event response.completed on a normal turn", async () => {
    const { text, upstream } = await runTransform([
      ...sseEvent("response.created", { type: "response.created", response: { id: "resp_3", status: "in_progress" } }),
      ...sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" }),
      ...sseEvent("response.completed", {
        type: "response.completed",
        response: { id: "resp_3", status: "completed", usage: { input_tokens: 5, output_tokens: 2 } },
      }),
    ]);

    const lines = text.trim().split("\n\n").filter(Boolean);
    const finalChunk = JSON.parse(lines[lines.length - 2].slice("data: ".length));
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
    expect(text).toContain("data: [DONE]");

    expect(upstream.terminal_event).toBe("response.completed");
    expect(upstream.errored).toBe(false);
  });

  it("keeps finish_reason tool_calls when the turn ends on a tool call", async () => {
    const { upstream, text } = await runTransform([
      ...sseEvent("response.created", { type: "response.created", response: { id: "resp_4", status: "in_progress" } }),
      ...sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "get_weather" },
      }),
      ...sseEvent("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" }),
      ...sseEvent("response.completed", { type: "response.completed", response: { id: "resp_4", status: "completed" } }),
    ]);

    const lines = text.trim().split("\n\n").filter(Boolean);
    const finalChunk = JSON.parse(lines[lines.length - 2].slice("data: ".length));
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");
    expect(upstream.terminal_event).toBe("response.completed");
    expect(upstream.output_items).toEqual({ function_call: 1 });
  });
});

// Bedrock's executor re-encodes raw ConverseStreamOutput 1:1 as `data: {json}` lines
// with no `event:` name — the event type is the single top-level key of the JSON
// object (messageStart, contentBlockDelta, …). See accumulateEventTypeCount in
// open-sse/utils/stream.js.
describe("JSON-only upstream (no event: lines) counts events by their single top-level key", () => {
  async function runPassthrough(lines) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines.join("\n")));
        controller.close();
      },
    });

    let upstream = null;
    const transform = createPassthroughStreamWithLogger(
      "bedrock", null, "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "conn", {},
      (content, usage, ttftAt, firstContentAt, upstreamArg) => { upstream = upstreamArg; },
    );

    const output = stream.pipeThrough(transform);
    const reader = output.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return upstream;
  }

  function bedrockLine(event) {
    return [`data: ${JSON.stringify(event)}`, ""];
  }

  it("counts messageStart/contentBlockDelta/contentBlockStop/messageStop/metadata", async () => {
    const upstream = await runPassthrough([
      ...bedrockLine({ messageStart: { role: "assistant" } }),
      ...bedrockLine({ contentBlockDelta: { delta: { text: "hi" }, contentBlockIndex: 0 } }),
      ...bedrockLine({ contentBlockDelta: { delta: { text: " there" }, contentBlockIndex: 0 } }),
      ...bedrockLine({ contentBlockStop: { contentBlockIndex: 0 } }),
      ...bedrockLine({ messageStop: { stopReason: "end_turn" } }),
      ...bedrockLine({ metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } }),
    ]);

    expect(upstream.events).toEqual({
      messageStart: 1,
      contentBlockDelta: 2,
      contentBlockStop: 1,
      messageStop: 1,
      metadata: 1,
    });
  });

  it("does not miscount a [DONE] sentinel or a multi-key (non-Bedrock-shaped) data line", async () => {
    const upstream = await runPassthrough([
      ...bedrockLine({ messageStart: { role: "assistant" } }),
      "data: [DONE]",
      "",
      // Two top-level keys — never mistaken for a single event name.
      `data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "hi" } }] })}`,
      "",
    ]);

    expect(upstream.events).toEqual({ messageStart: 1 });
  });
});
