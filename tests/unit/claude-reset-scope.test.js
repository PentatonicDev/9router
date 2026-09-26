import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getScopeFilter: vi.fn(),
  consumeClaudeResetGrant: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.getProviderConnectionById }));
vi.mock("@/lib/auth/resourceScope", () => ({
  canSee: (connection, filter) => !filter || connection.owner === null || connection.owner === filter.owner,
  getScopeFilter: mocks.getScopeFilter,
}));
vi.mock("open-sse/services/usage.js", () => ({ consumeClaudeResetGrant: mocks.consumeClaudeResetGrant }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig }));
vi.mock("../../src/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials }));

const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
const request = () => new Request("http://localhost/api/usage/c1/claude-reset", {
  method: "POST",
  body: JSON.stringify({ grantId: "g1" }),
});
const params = { params: Promise.resolve({ connectionId: "c1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getScopeFilter.mockResolvedValue({ owner: "alice@example.com" });
  mocks.getProviderConnectionById.mockResolvedValue({
    id: "c1", owner: "bob@example.com", provider: "claude", authType: "oauth", accessToken: "secret",
  });
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.refreshAndUpdateCredentials.mockImplementation(async (connection) => ({ connection }));
  mocks.consumeClaudeResetGrant.mockResolvedValue({ ok: true });
});

describe("POST /api/usage/[connectionId]/claude-reset", () => {
  it("não consome grant de conexão de outro proprietário", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(404);
    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(mocks.consumeClaudeResetGrant).not.toHaveBeenCalled();
  });

  it("consome grant de conexão visível", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "c1", owner: "alice@example.com", provider: "claude", authType: "oauth", accessToken: "secret",
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(mocks.consumeClaudeResetGrant).toHaveBeenCalledWith("secret", "g1", expect.any(Object));
  });
});
