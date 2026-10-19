import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshKiroToken: vi.fn(async () => ({ accessToken: "fresh" })),
}));

const { resolveKiroModels, clearKiroModelCache } = await import("../../open-sse/services/kiroModels.js");

afterEach(() => { vi.unstubAllGlobals(); clearKiroModelCache(); });

describe("resolveKiroModels token refresh", () => {
  it("refreshes and retries when ListAvailableModels answers 403 bearer token invalid", async () => {
    const fetchMock = vi.fn(async (_url, init) => init.headers.Authorization === "Bearer fresh"
      ? new Response(JSON.stringify({ models: [{ modelId: "claude-sonnet-5", modelName: "Sonnet 5" }] }), { status: 200 })
      : new Response('{"message":"The bearer token included in the request is invalid.","reason":null}', { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveKiroModels({ accessToken: "stale", refreshToken: "r" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.models.some((m) => m.upstreamModelId === "claude-sonnet-5")).toBe(true);
  });
});

describe("resolveKiroModels TokenType header", () => {
  it.each([["api_key", "API_KEY"], ["external_idp", "EXTERNAL_IDP"], ["social", undefined]])(
    "authMethod %s sends TokenType %s", async (authMethod, expected) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [{ modelId: "auto" }] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await resolveKiroModels({ accessToken: "k", providerSpecificData: { authMethod } });

      expect(fetchMock.mock.calls[0][1].headers.TokenType).toBe(expected);
    });
});
