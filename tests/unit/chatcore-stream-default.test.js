import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, forcedSSEToJsonMock, nonStreamingMock, streamingMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  forcedSSEToJsonMock: vi.fn(),
  nonStreamingMock: vi.fn(),
  streamingMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: forcedSSEToJsonMock,
}));
vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: nonStreamingMock,
}));
vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  handleStreamingResponse: streamingMock,
  buildOnStreamComplete: () => ({ onStreamComplete: vi.fn(), streamDetailId: null }),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");

const abortRequest = (options = {}) => handleChatCore({
  body: { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }] },
  modelInfo: { provider: "deepseek", model: "deepseek-chat" },
  credentials: { apiKey: "test-key", providerSpecificData: {} },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
  connectionId: "test-connection",
  rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false,
  ponytailEnabled: false, pxpipeEnabled: false,
  ...options,
});

async function run(provider, model, bodyExtra, headers = {}) {
  const body = { model: `${provider}/${model}`, messages: [{ role: "user", content: "hi" }], ...bodyExtra };
  await handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers },
  });
  return executeMock.mock.calls.at(-1)[0].stream;
}

describe("chatCore stream mode when the client omits `stream`", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const ok = { success: true, response: new Response("{}", { status: 200 }) };
    executeMock.mockResolvedValue({ response: new Response("{}", { status: 200 }), url: "https://upstream/v1/chat/completions", headers: {} });
    forcedSSEToJsonMock.mockResolvedValue(ok);
    nonStreamingMock.mockResolvedValue(ok);
    streamingMock.mockResolvedValue(ok);
  });

  it.each(["AbortError", "Error"])("maps internal %s to retryable 502", async (name) => {
    executeMock.mockRejectedValueOnce(Object.assign(new Error("upstream transport aborted"), { name }));
    const controller = new AbortController();
    const result = await abortRequest({ signal: controller.signal });
    expect(controller.signal.aborted).toBe(false);
    expect(result.status).toBe(502);
    expect(result.descriptor.routing.retryable).toBe(true);
    expect(saveRequestDetail.mock.calls.at(-1)[0].response.status).toBe(502);
  });

  it.each(["AbortError", "ResponseAborted"])("keeps real client cancellation as 499 for %s", async (name) => {
    const controller = new AbortController();
    executeMock.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error("client left"), { name });
    });
    const result = await abortRequest({ signal: controller.signal });
    expect(result.status).toBe(499);
    expect(result.descriptor.routing.retryable).toBe(false);
    expect(saveRequestDetail.mock.calls.at(-1)[0].response.status).toBe(499);
  });

  it("maps an upstream HTTP 499 to retryable 502", async () => {
    executeMock.mockResolvedValueOnce({ response: new Response("Client Closed Request", { status: 499 }), headers: {} });
    const result = await abortRequest();
    expect(result.status).toBe(502);
    expect(result.descriptor.routing.retryable).toBe(true);
    expect(result.error).toContain("Upstream HTTP 499");
    expect(saveRequestDetail.mock.calls.at(-1)[0].response.status).toBe(502);
  });

  it("tries the next combo member after an internal abort without exposing the failure", async () => {
    executeMock.mockRejectedValueOnce(new DOMException("internal abort", "AbortError"));
    const attempts = vi.fn(async () => (await abortRequest()).response);
    const result = await handleComboChat({
      body: {}, models: ["deepseek/one", "deepseek/two"], handleSingleModel: attempts,
      log: { info: vi.fn(), warn: vi.fn() }, comboStrategy: "fallback",
    });
    expect(result.status).toBe(200);
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(saveRequestDetail.mock.calls.at(-1)[0].response.status).toBe(502);
  });

  it("omitted → JSON (spec default), no Accept header needed", async () => {
    expect(await run("deepseek", "deepseek-chat", {})).toBe(false);
    expect(nonStreamingMock).toHaveBeenCalledTimes(1);
    expect(streamingMock).not.toHaveBeenCalled();
  });

  it("stream:false → JSON", async () => {
    expect(await run("deepseek", "deepseek-chat", { stream: false })).toBe(false);
    expect(nonStreamingMock).toHaveBeenCalledTimes(1);
  });

  it("stream:true → SSE", async () => {
    expect(await run("deepseek", "deepseek-chat", { stream: true })).toBe(true);
    expect(streamingMock).toHaveBeenCalledTimes(1);
    expect(nonStreamingMock).not.toHaveBeenCalled();
  });

  it("forceStream provider + omitted → upstream SSE converted to JSON", async () => {
    expect(await run("openai", "gpt-4o", {})).toBe(true);
    expect(forcedSSEToJsonMock).toHaveBeenCalledTimes(1);
    expect(streamingMock).not.toHaveBeenCalled();
  });
});
