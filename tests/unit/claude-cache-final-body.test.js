import { expect, it, vi } from "vitest";

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

it.each([false, true])("respects PXPIPE cache ownership=%s on a translated Claude request", async (ownsCacheControl) => {
  executeMock.mockReset().mockRejectedValue(new Error("stop before network"));
  const body = {
    model: "claude-sonnet-4-6", stream: false,
    messages: [{ role: "user", content: "question" }],
  };
  const transform = vi.fn(async ({ body: bytes }) => {
    const translated = JSON.parse(new TextDecoder().decode(bytes));
    expect(translated.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    translated.system.push({ type: "text", text: "pxpipe final block" });
    return { applied: true, body: new TextEncoder().encode(JSON.stringify(translated)), cache: { ownsCacheControl } };
  });
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  await handleChatCore({
    body, modelInfo: { provider: "anthropic", model: "claude-sonnet-4-6" },
    credentials: { apiKey: "test-key" }, connectionId: "conn",
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
    pxpipeEnabled: true, pxpipeMinChars: 1, pxpipeTransform: transform,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  expect(transform).toHaveBeenCalledOnce();
  expect(executeMock).toHaveBeenCalledOnce();
  const outbound = executeMock.mock.calls[0][0].body;
  expect(outbound.system.at(-1).text).toBe("pxpipe final block");
  expect(outbound.system.at(-1).cache_control).toEqual(ownsCacheControl ? undefined : { type: "ephemeral", ttl: "1h" });
  expect(outbound.system.at(-2).cache_control).toEqual(ownsCacheControl ? { type: "ephemeral", ttl: "1h" } : undefined);
});
