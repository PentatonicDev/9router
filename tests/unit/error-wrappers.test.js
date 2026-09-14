import { describe, expect, it, vi } from "vitest";

import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  initTranslators: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: mocks.initTranslators }));

const { POST: compact } = await import("../../src/app/api/v1/responses/compact/route.js");

describe("public error wrappers", () => {
  it("preserves an Ollama error response without adding done:true", async () => {
    const response = new Response(JSON.stringify({ error: "quota" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "11",
        "X-9Router-Retry-At": "2099-01-01T00:00:00.000Z",
      },
    });

    const result = transformToOllama(response, "m");

    expect(result).toBe(response);
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("11");
    expect(await result.text()).toBe('{"error":"quota"}');
  });

  it("returns an OpenAI Responses error for invalid compact JSON", async () => {
    const response = await compact(new Request("https://router.test/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Invalid JSON body",
        type: "invalid_request_error",
        param: null,
        code: "bad_request",
      },
    });
  });

  it("keeps one request id when compact delegates to chat", async () => {
    mocks.handleChat.mockImplementation(async (_request, _raw, context) => {
      expect(context.errorFormat).toBe("openai-responses");
      return new Response(null, { headers: { "X-Request-Id": context.requestId } });
    });

    const response = await compact(new Request("https://router.test/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "provider/model", input: "hello" }),
    }));

    expect(response.headers.get("X-Request-Id")).toMatch(/^req_/);
  });
});
