import { afterEach, describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createStreamingResponse } from "../../open-sse/utils/streamHandler.js";
import { STREAM_STATUS_GRACE_MS } from "../../open-sse/config/runtimeConfig.js";

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

// The hold expires first, so the response opens on the heartbeat path.
async function openAfterGrace(promise) {
  await vi.advanceTimersByTimeAsync(STREAM_STATUS_GRACE_MS);
  return promise;
}

afterEach(() => vi.useRealTimers());

describe("createStreamingResponse", () => {
  it("opens at the grace deadline, heartbeats while routing waits, then preserves final bytes", async () => {
    vi.useFakeTimers();
    const routing = deferred();
    const response = await openAfterGrace(
      createStreamingResponse(() => routing.promise, { clientFormat: FORMATS.OPENAI }),
    );
    const reader = response.body.getReader();

    expect(response.status).toBe(200);
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

  it("commits to 200 the moment routing succeeds, without waiting out the hold", async () => {
    vi.useFakeTimers();
    const response = await createStreamingResponse(
      () => Promise.resolve(responseOf("data: [DONE]\n\n")),
      { clientFormat: FORMATS.OPENAI },
    );
    // No timer was advanced: routing settled, so the hold was skipped entirely.
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    expect((await readChunk(reader)).text).toBe(": ping\n\n");
    expect((await readChunk(reader)).text).toBe("data: [DONE]\n\n");
  });

  it("never splits an SSE event with a heartbeat", async () => {
    vi.useFakeTimers();
    const routing = deferred();
    const response = await openAfterGrace(
      createStreamingResponse(() => routing.promise, { clientFormat: FORMATS.OPENAI }),
    );
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

  it("cancels routing when the client disconnects after the grace deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const routing = deferred();
    let upstreamAborted = false;
    const response = await openAfterGrace(createStreamingResponse((signal) => {
      signal.addEventListener("abort", () => { upstreamAborted = true; });
      return routing.promise;
    }, { signal: controller.signal }));
    const reader = response.body.getReader();
    expect((await readChunk(reader)).text).toBe(": ping\n\n");

    controller.abort("client left");
    expect(upstreamAborted).toBe(true);
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("keeps concurrent request state isolated", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    let firstAborted = false;
    let secondAborted = false;
    const a = await openAfterGrace(createStreamingResponse((signal) => {
      signal.addEventListener("abort", () => { firstAborted = true; });
      return first.promise;
    }));
    const b = await openAfterGrace(createStreamingResponse((signal) => {
      signal.addEventListener("abort", () => { secondAborted = true; });
      return second.promise;
    }));
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

  // A failure that resolves inside the hold answers with its own status. Writing it
  // as an SSE error frame inside an already-committed 200 hides the real cause: a
  // client that treats 200 as "stream started" sees an empty stream and reports a
  // truncated response instead of the 429/503 the gateway actually produced.
  it.each([
    [FORMATS.OPENAI, 503],
    [FORMATS.CLAUDE, 429],
    [FORMATS.OPENAI_RESPONSES, 502],
  ])("answers an early %s routing failure with its real HTTP status", async (format, status) => {
    const error = new Response(JSON.stringify({ error: { message: "provider unavailable" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    const response = await createStreamingResponse(() => Promise.resolve(error), { clientFormat: format });

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toContain("provider unavailable");
  });

  it("carries the routing reason headers through to the client", async () => {
    const error = new Response(JSON.stringify({ error: { message: "quota" } }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "X-9Router-Reason": "quota_exhausted",
        "Retry-After": "30",
      },
    });
    const response = await createStreamingResponse(() => Promise.resolve(error), { clientFormat: FORMATS.CLAUDE });
    expect(response.status).toBe(429);
    expect(response.headers.get("X-9Router-Reason")).toBe("quota_exhausted");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("turns a routing rejection into a real 502 rather than a 200 body frame", async () => {
    const response = await createStreamingResponse(
      () => Promise.reject(new Error("socket hang up while selecting account")),
      { clientFormat: FORMATS.CLAUDE },
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.type).toBe("error");
    // Transport wording is not echoed back to the client.
    expect(body.error.message).not.toContain("socket hang up");
  });

  // Routing that outlives the hold already answered 200, so the failure has to be
  // delivered as a terminal SSE event in the client's own format.
  it.each([
    [FORMATS.OPENAI, 503, 'data: {"error"', "data: [DONE]"],
    [FORMATS.CLAUDE, 429, "event: error", "rate_limit_error"],
    [FORMATS.OPENAI_RESPONSES, 502, "event: response.failed", "response.failed"],
  ])("turns a late %s routing failure into a terminal SSE event", async (format, status, marker, detail) => {
    vi.useFakeTimers();
    const error = new Response(JSON.stringify({ error: { message: "provider unavailable" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    const routing = deferred();
    const response = await openAfterGrace(
      createStreamingResponse(() => routing.promise, { clientFormat: format }),
    );
    const reader = response.body.getReader();

    expect(response.status).toBe(200);
    expect((await readChunk(reader)).text).toBe(": ping\n\n");

    routing.resolve(error);
    const terminal = (await readChunk(reader)).text;
    expect(terminal).toContain(marker);
    expect(terminal).toContain(detail);
    expect(terminal).toContain("provider unavailable");
    expect((await readChunk(reader)).done).toBe(true);
  });
});
