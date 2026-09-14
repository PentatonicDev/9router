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
