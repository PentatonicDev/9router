import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runThrough(transform, text) {
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  await new Response(source.pipeThrough(transform)).text();
}

describe("passthrough TTFT", () => {
  it("counts a Claude-native content_block_delta as first content", async () => {
    let seen = null;
    const transform = createPassthroughStreamWithLogger("anthropic", null, "claude", "conn", {}, (content, usage, ttftAt, firstContentAt) => {
      seen = { ttftAt, firstContentAt };
    });
    await runThrough(transform, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(""));
    expect(seen.ttftAt).toBeTypeOf("number");
    expect(seen.firstContentAt).toBeTypeOf("number");
  });

  it("leaves first content unset when only an opener arrives", async () => {
    let seen = null;
    const transform = createPassthroughStreamWithLogger("anthropic", null, "claude", "conn", {}, (content, usage, ttftAt, firstContentAt) => {
      seen = { ttftAt, firstContentAt };
    });
    await runThrough(transform, 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n');
    expect(seen.ttftAt).toBeTypeOf("number");
    expect(seen.firstContentAt).toBeNull();
  });
});
