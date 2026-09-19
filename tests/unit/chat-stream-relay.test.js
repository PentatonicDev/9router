import { afterEach, describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createStreamingResponse } from "../../open-sse/utils/streamHandler.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function responseOf(text) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function readChunk(reader) {
  const { value, done } = await reader.read();
  return { text: done ? "" : decoder.decode(value), done };
}

afterEach(() => vi.useRealTimers());

describe("createStreamingResponse", () => {
  it("opens immediately, heartbeats while routing waits, then preserves final bytes", async () => {
    vi.useFakeTimers();
    const routing = deferred();
    const response = createStreamingResponse(() => routing.promise, { clientFormat: FORMATS.OPENAI });
    const reader = response.body.getReader();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(await readChunk(reader)).toEqual({ text: ": ping\n\n", done: false });

    const second = readChunk(reader);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await second).toEqual({ text: ": ping\n\n", done: false });

    routing.resolve(responseOf('data: {"choices":[]}\n\ndata: [DONE]\n\n'));
    expect((await readChunk(reader)).text).toBe('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    expect((await readChunk(reader)).done).toBe(true);
  });

  it("never splits an SSE event with a heartbeat", async () => {
    vi.useFakeTimers();
    const routing = deferred();
    const response = createStreamingResponse(() => routing.promise, { clientFormat: FORMATS.OPENAI });
    const reader = response.body.getReader();
    await readChunk(reader);

    routing.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created"'));
      },
    }), { headers: { "Content-Type": "text/event-stream" } }));

    const partial = readChunk(reader);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await partial).text).toBe('event: response.created\ndata: {"type":"response.created"');
    await reader.cancel("done");
  });

  it("keeps concurrent request state isolated", async () => {
    const first = deferred();
    const second = deferred();
    let firstAborted = false;
    let secondAborted = false;
    const a = createStreamingResponse((signal) => {
      signal.addEventListener("abort", () => { firstAborted = true; });
      return first.promise;
    });
    const b = createStreamingResponse((signal) => {
      signal.addEventListener("abort", () => { secondAborted = true; });
      return second.promise;
    });
    const readerA = a.body.getReader();
    const readerB = b.body.getReader();

    await readerA.read();
    await readerB.read();
    await readerA.cancel("client left");
    expect(firstAborted).toBe(true);
    expect(secondAborted).toBe(false);

    second.resolve(responseOf("data: [DONE]\n\n"));
    expect((await readChunk(readerB)).text).toBe("data: [DONE]\n\n");
    expect((await readChunk(readerB)).done).toBe(true);
  });

  it.each([
    [FORMATS.OPENAI, 503, 'data: {"error"', "data: [DONE]"],
    [FORMATS.CLAUDE, 429, "event: error", "rate_limit_error"],
    [FORMATS.OPENAI_RESPONSES, 502, "event: response.failed", "response.failed"],
  ])("turns an early %s routing failure into a terminal SSE event", async (format, status, marker, detail) => {
    const error = new Response(JSON.stringify({ error: { message: "provider unavailable" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    const response = createStreamingResponse(() => Promise.resolve(error), { clientFormat: format });
    const reader = response.body.getReader();

    expect((await readChunk(reader)).text).toBe(": ping\n\n");
    const terminal = (await readChunk(reader)).text;
    expect(terminal).toContain(marker);
    expect(terminal).toContain(detail);
    expect(terminal).toContain("provider unavailable");
    expect((await readChunk(reader)).done).toBe(true);
  });
});
