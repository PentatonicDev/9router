/**
 * End-to-end proof (mocked SDK stream, real translate pipeline): a Bedrock
 * ConverseStreamOutput sequence, re-encoded by the executor as SSE-of-JSON,
 * goes through the SAME createSSETransformStreamWithLogger() every other
 * provider uses, and usage + finish_reason reach onStreamComplete — not just
 * the individual translator unit, but the whole utils/stream.js wiring
 * (extractUsage / state.usage / finalizeStream) the task asked to prove.
 */
import { describe, it, expect } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// Mirrors BedrockExecutor's own re-encoding: `data: ${JSON.stringify(evt)}\n\n` per event.
function bedrockSSE(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function runBedrockStream(events, onStreamComplete) {
  const encoder = new TextEncoder();
  const raw = bedrockSSE(events);
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });

  const output = source.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.BEDROCK_CONVERSE, FORMATS.OPENAI, "bedrock", null, null,
      "anthropic.claude-sonnet-4-5-20250929-v1:0", "conn-1", {}, onStreamComplete,
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("Bedrock stream, end to end through createSSETransformStreamWithLogger", () => {
  it("delivers text deltas and passes usage + finish_reason to onStreamComplete", async () => {
    let completed = null;
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { text: "Ol" }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { text: "a" }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } } },
    ];

    const out = await runBedrockStream(events, (content, usage, ttftAt, firstContentAt, upstream) => {
      completed = { content, usage, upstream };
    });

    const lines = out.split("\n\n").filter((l) => l.startsWith("data:") && l !== "data: [DONE]");
    const deltas = lines.map((l) => JSON.parse(l.slice(5)));
    const text = deltas.map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(text).toBe("Ola");

    expect(completed).not.toBeNull();
    expect(completed.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
    expect(completed.upstream.finish_reason).toBe("stop");
  });

  it("terminates the client stream with data: [DONE] after the finish chunk", async () => {
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { text: "hi" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
    ];

    const out = await runBedrockStream(events, () => {});

    // The finish chunk (carrying usage) must be the frame right before [DONE] —
    // not just present somewhere in the stream — matching every other
    // translate-mode provider's termination shape for an OpenAI-format client.
    const frames = out.split("\n\n").filter(Boolean);
    expect(frames.at(-1)).toBe("data: [DONE]");
    const finishFrame = JSON.parse(frames.at(-2).slice(5));
    expect(finishFrame.choices[0].finish_reason).toBe("stop");
    expect(finishFrame.usage).toBeTruthy();
  });

  it("propagates finish_reason: tool_calls when the model stops for a tool call", async () => {
    let completed = null;
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { start: { toolUse: { toolUseId: "call_1", name: "f" } }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { toolUse: { input: "{}" } }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } },
    ];

    await runBedrockStream(events, (content, usage, ttftAt, firstContentAt, upstream) => {
      completed = { usage, upstream };
    });

    expect(completed.upstream.finish_reason).toBe("tool_calls");
    expect(completed.usage.total_tokens).toBe(6);
  });

  // Reproduces skeptic review finding #1 through the REAL shared pipeline (the
  // same one every other provider's stream runs through), not just the
  // translator unit. The executor's fix (open-sse/executors/bedrock.js)
  // re-encodes an inline exception event as `{error:{message}}` before this
  // pipeline ever sees it — extractStreamError() recognizes that raw shape
  // and finalizes the stream cleanly instead of falling through to
  // translateResponse(). (Runtime-verified: in TRANSLATE mode an error
  // terminal deliberately does NOT get a trailing `[DONE]` — flush()'s
  // `if (streamErrored) { finalizeStream(); return; }` skips it, unlike
  // PASSTHROUGH mode — the error frame itself is the terminal signal.)
  it("delivers a client-format error frame and finalizes cleanly for the executor's corrected exception encoding", async () => {
    const events = [
      { messageStart: { role: "assistant" } },
      { error: { message: "boom" } },
    ];
    let completed = null;
    const out = await runBedrockStream(events, (content, usage, ttftAt, firstContentAt, upstream) => {
      completed = upstream;
    });

    const errorLine = out.split("\n\n").find((l) => l.includes('"error"'));
    expect(JSON.parse(errorLine.slice(5)).error.message).toBe("boom");
    expect(completed).not.toBeNull();
    expect(completed.errored).toBe(true);
  });
});
