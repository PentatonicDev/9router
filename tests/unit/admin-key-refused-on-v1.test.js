// Admin keys authenticate the dashboard REST API as their owner (see
// resourceScope.js); they must never be usable as a /v1 routing credential.
// This covers the refusal at its exact insertion point in chat.js — right
// after apiKeyContext resolves, unconditionally (even when requireApiKey is
// off) — using the same mock shape tests/unit/combo-thinking-cap.test.js
// already proved works for driving handleChat() end to end.
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getApiKeyRoutingContext: vi.fn(),
  getProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  augmentModelsWithCapacityAdapter: vi.fn(),
  withCapacityAdapterStripping: vi.fn(),
  getActiveAdapterStrategy: vi.fn(),
  handleBypassRequest: vi.fn(),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getApiKeyRoutingContext: mocks.getApiKeyRoutingContext,
}));
vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleFusionChat,
  detectRequiredCapabilities: mocks.detectRequiredCapabilities,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn((request) => request.headers.get("authorization")?.slice(7) || null),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: mocks.augmentModelsWithCapacityAdapter,
  withCapacityAdapterStripping: mocks.withCapacityAdapterStripping,
  getActiveAdapterStrategy: mocks.getActiveAdapterStrategy,
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.handleBypassRequest }));

function chatRequest(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("chat.js — admin key refused on /v1", () => {
  // chat.js pulls in most of the engine; under a loaded full-suite run that first
  // import alone crossed the 5s per-test timeout. Warm it outside the tests.
  beforeAll(async () => { await import("../../src/sse/handlers/chat.js"); }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.handleBypassRequest.mockReturnValue(null);
    mocks.detectRequiredCapabilities.mockReturnValue(new Set());
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
    mocks.withCapacityAdapterStripping.mockImplementation((fn) => fn);
    mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "conn-1", providerSpecificData: {} });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });
  });

  it("an admin-kind key gets 403 with the exact reason, and never reaches handleChatCore", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: "alice@corp.com", kind: "admin" });

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const res = await handleChat(chatRequest("sk-admin-key"));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.message || body.error).toContain("Administration keys cannot route LLM traffic");
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  // The whole point of this check is that it runs even when no key is
  // required at all — an admin key is refused as a *routing* credential,
  // not merely as "any invalid/missing key" (requireApiKey stays false here).
  it("refuses the admin key even when requireApiKey is false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: "alice@corp.com", kind: "admin" });

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const res = await handleChat(chatRequest("sk-admin-key"));

    expect(res.status).toBe(403);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("a usage-kind key routes normally (mutation-proof: only kind differs from the passing case above)", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: "alice@corp.com", kind: "usage" });

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const res = await handleChat(chatRequest("sk-usage-key"));

    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
});
