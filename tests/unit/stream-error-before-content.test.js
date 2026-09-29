import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleStreamingResponse, buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");

const sse = (...frames) => new Response(new ReadableStream({
  start(c) {
    for (const f of frames) c.enqueue(new TextEncoder().encode(f));
    c.close();
  }
}), { headers: { "content-type": "text/event-stream" } });

const run = (providerResponse, { sourceFormat = "openai", targetFormat = "openai" } = {}) => {
  const onRequestSuccess = vi.fn();
  const ctx = { provider: "openai", model: "m", body: { model: "m", messages: [] }, stream: true, requestStartTime: Date.now() };
  const result = handleStreamingResponse({
    ...ctx, ...buildOnStreamComplete(ctx), providerResponse, sourceFormat, targetFormat,
    streamController: createStreamController({ provider: "openai", model: "m" }),
    onRequestSuccess,
  });
  return result.then(r => ({ result: r, onRequestSuccess }));
};

const ERROR_FRAME = 'data: {"error":{"message":"[server_error] upstream service failed"}}\n\ndata: [DONE]\n\n';
const CONTENT_FRAME = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n';

describe("stream error before any content", () => {
  it("fails routing on a passthrough error event so fallback can run", async () => {
    const { result, onRequestSuccess } = await run(sse(ERROR_FRAME));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("upstream service failed");
    expect(onRequestSuccess).not.toHaveBeenCalled();
    const { saveRequestDetail } = await import("@/lib/usageDb.js");
    await vi.waitFor(() => expect(saveRequestDetail.mock.calls.some(([d]) => d.upstream?.error?.includes("upstream service failed"))).toBe(true));
  });

  it("fails routing on a translated error after a heartbeat comment", async () => {
    const { result } = await run(sse(": kiro-validation\n\n", ERROR_FRAME), { sourceFormat: "claude", targetFormat: "openai" });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });

  it("streams content, then the late error, unchanged", async () => {
    const { result, onRequestSuccess } = await run(sse(CONTENT_FRAME, ERROR_FRAME));
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("upstream service failed");
    await vi.waitFor(() => expect(onRequestSuccess).toHaveBeenCalledOnce());
  });

  it("fails routing when the upstream stalls before any content", async () => {
    const streamController = createStreamController({ provider: "openai", model: "m" });
    const stalled = new Response(new ReadableStream({
      start(c) {
        streamController.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      }
    }), { headers: { "content-type": "text/event-stream" } });
    setTimeout(() => { streamController.handleError(new Error("stream stall timeout")); streamController.abort(); }, 20);
    const result = await handleStreamingResponse({
      providerResponse: stalled, provider: "openai", model: "m", sourceFormat: "openai", targetFormat: "openai",
      body: { model: "m", messages: [] }, stream: true, requestStartTime: Date.now(), streamController,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });

  it("counts reasoning-only deltas as content", async () => {
    const reasoning = 'data: {"choices":[{"index":0,"delta":{"reasoning":"thinking"}}]}\n\n';
    const { result } = await run(sse(reasoning, ERROR_FRAME));
    expect(result.success).toBe(true);
  });
});
