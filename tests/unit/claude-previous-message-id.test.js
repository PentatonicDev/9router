import { describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({ signal: undefined, handleError: vi.fn() })),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
}));

async function outboundDiagnostics(previousMessageId, userAgent) {
  executeMock.mockReset().mockRejectedValue(new Error("stop before network"));
  const body = {
    model: "claude-sonnet-4-6", max_tokens: 64, stream: false,
    messages: [{ role: "user", content: [{ type: "text", text: "oi" }] }],
    diagnostics: { previous_message_id: previousMessageId },
  };
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  await handleChatCore({
    body, modelInfo: { provider: "anthropic", model: "claude-sonnet-4-6" },
    credentials: { apiKey: "test-key" }, connectionId: "conn", sourceFormatOverride: "claude",
    clientRawRequest: { endpoint: "/v1/messages", body, headers: { accept: "application/json", "user-agent": userAgent } },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  expect(executeMock).toHaveBeenCalledOnce();
  return executeMock.mock.calls[0][0].body.diagnostics;
}

describe("diagnostics.previous_message_id sent to Anthropic", () => {
  it.each([
    ["claude-cli/2.1.0 (external, cli)", "native passthrough"],
    ["curl/8", "translated"],
  ])("gets the msg_ prefix Anthropic requires (%s → %s)", async (userAgent) => {
    expect(await outboundDiagnostics("abc123def456", userAgent)).toEqual({ previous_message_id: "msg_abc123def456" });
    expect(await outboundDiagnostics("msg_01XFDUDYJgAACzvnptvVoYEL", userAgent))
      .toEqual({ previous_message_id: "msg_01XFDUDYJgAACzvnptvVoYEL" });
  });
});

describe("Claude message ids emitted for non-Anthropic upstreams", () => {
  it("streaming message_start carries a msg_ id", async () => {
    const { translateResponse, initState } = await import("../../open-sse/translator/index.js");
    const firstChunk = (id) => ({ id, model: "glm-5", choices: [{ index: 0, delta: { role: "assistant", content: "oi" } }] });
    const startId = (chunk) => translateResponse("openai", "claude", chunk, initState("claude"))
      .find((e) => e.type === "message_start").message.id;

    expect(startId(firstChunk("chatcmpl-abc123def456"))).toBe("msg_abc123def456");
    expect(startId(firstChunk("resp_0123456789"))).toBe("msg_resp_0123456789");
    expect(startId(firstChunk("chat"))).toMatch(/^msg_\d+$/);
  });
});
