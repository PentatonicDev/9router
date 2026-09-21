/**
 * handleNonStreamingResponse (genuinely non-stream JSON providers, not a forced-
 * stream aggregation) used to save a request detail with no `phases` and no
 * `upstream` — the streaming path records both (see streamingHandler.js
 * buildOnStreamComplete). A non-stream turn still has a meaningful
 * client_complete_ms, so it should carry `phases` too; it has no upstream
 * event stream to summarize, so `upstream` stays undefined (see
 * bedrock-forced-nonstream.test.js for the forced-stream-aggregation case,
 * where upstream IS applicable).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

const stubReqLogger = { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() };

describe("handleNonStreamingResponse — plain JSON provider (no forced stream involved)", () => {
  it("saves phases with client_complete_ms and leaves upstream undefined", async () => {
    saveRequestDetail.mockClear();
    const requestStartTime = Date.now() - 30;

    await handleNonStreamingResponse({
      providerResponse: jsonResponse({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "gpt-test",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }),
      provider: "openai",
      errorContext: {},
      model: "gpt-test",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { model: "gpt-test", messages: [] },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime,
      connectionId: "conn",
      apiKey: "key",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: null,
      reqLogger: stubReqLogger,
      toolNameMap: null,
      customToolNames: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      pxpipe: null,
      reqTag: "t",
      log: null,
      phases: { t0: requestStartTime, entry_ms: 2, preprocess_ms: 5 }
    });

    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    const detail = saveRequestDetail.mock.calls[0][0];

    expect(detail.phases.entry_ms).toBe(2);
    expect(detail.phases.preprocess_ms).toBe(5);
    expect(typeof detail.phases.client_complete_ms).toBe("number");
    expect(detail.phases.client_complete_ms).toBeGreaterThanOrEqual(0);
    expect(detail.upstream).toBeUndefined();
  });
});
