import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  getApiKeyRoutingContext: vi.fn(),
  handleSystemoneCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: true, scopeResourcesByUser: true })),
  getApiKeyRoutingContext: mocks.getApiKeyRoutingContext,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer /, "") || null,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "vercel-ai-gateway", model: "typesafe-ai/jev" })),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: vi.fn(async (_provider, credential) => credential) }));
vi.mock("../../open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.handleSystemoneCore }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));

import { handleSystemone } from "../../src/sse/handlers/systemone.js";

const request = (connectionId) => new Request("http://localhost/api/v1/systemone", {
  method: "POST",
  headers: {
    authorization: "Bearer sk-client",
    ...(connectionId ? { "x-connection-id": connectionId } : {}),
  },
  body: JSON.stringify({ model: "vercel/typesafe-ai/jev", state: "hello", questions: { urgent: { type: "noul", instructions: "Urgent?" } } }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, kind: "usage", owner: "owner-1", allowedConnectionIds: ["conn-1"] });
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "allowed", apiKey: "upstream-key" });
  mocks.handleSystemoneCore.mockResolvedValue({ success: true, response: new Response("ok") });
});

describe("System One account binding", () => {
  it("uses caller key for access control and the selected connection for upstream auth", async () => {
    const response = await handleSystemone(request("conn-1"));
    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("vercel-ai-gateway", expect.any(Set), "typesafe-ai/jev", expect.objectContaining({
      apiKey: "sk-client", keyOwner: "owner-1", allowedConnectionIds: ["conn-1"], preferredConnectionId: "conn-1",
    }));
    expect(mocks.handleSystemoneCore).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ apiKey: "upstream-key" }),
    }));
  });

  it("sends the connection key upstream, never the caller key", async () => {
    const { handleSystemoneCore } = await vi.importActual("../../open-sse/handlers/systemoneCore.js");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ answers: {} }), { status: 200 }));
    try {
      const result = await handleSystemoneCore({
        body: { model: "vercel/typesafe-ai/jev", state: "hello", questions: { urgent: { type: "noul", instructions: "Urgent?" } } },
        modelInfo: { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" },
        credentials: { apiKey: "upstream-key" },
      });
      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer upstream-key");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("passes no account pin for curl without x-connection-id", async () => {
    await handleSystemone(request());
    expect(mocks.getProviderCredentials.mock.calls[0][3].preferredConnectionId).toBeNull();
  });

  it("refuses admin keys even when they are active", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, kind: "admin", owner: "owner-1", allowedConnectionIds: null });
    expect((await handleSystemone(request())).status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("does not call upstream when bound accounts are unavailable", async () => {
    mocks.getProviderCredentials.mockResolvedValue({ noActiveCredentials: true, candidate: {
      reason: "no_active_credentials", provider: "vercel-ai-gateway", status: 503,
      errorType: "api_error", message: "No active credentials", retryable: false,
    } });
    expect((await handleSystemone(request("conn-2"))).status).toBe(503);
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });
});
