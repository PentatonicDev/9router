import { expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

it("stores a thinking-only turn without labelling it empty", async () => {
  const { saveRequestDetail } = await import("@/lib/usageDb.js");
  const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
  const { onStreamComplete } = buildOnStreamComplete({
    provider: "anthropic", model: "claude", connectionId: "conn", apiKey: "key",
    requestStartTime: Date.now(), body: { model: "claude", messages: [] }, stream: true,
  });
  onStreamComplete({ content: "", thinking: "reason", toolCalls: 0 }, null, null, Date.now(), {});
  expect(saveRequestDetail).toHaveBeenCalledOnce();
  expect(saveRequestDetail.mock.calls[0][0].response).toMatchObject({
    content: "[No text output - thinking only]", thinking: "reason", type: "streaming",
  });
});
