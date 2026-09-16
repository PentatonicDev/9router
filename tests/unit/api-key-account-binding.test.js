import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(),
  getApiKeys: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: mocks.getApiKeyAllowedConnectionIds,
  getApiKeys: mocks.getApiKeys,
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));

const { getProviderCredentials } = await import("@/sse/services/auth.js");
const { GET: providersClientGET } = await import("@/app/api/providers/client/route.js");

const conn = (id, extra = {}) => ({
  id,
  provider: "claude",
  authType: "oauth",
  isActive: true,
  priority: 1,
  accessToken: `tok-${id}`,
  providerSpecificData: {},
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({});
  mocks.getProxyPools.mockResolvedValue([]);
});

describe("account binding — credential selection", () => {
  it("routes only to a bound account", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a"), conn("b")]);
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["b"]);

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: "sk-bound" });

    expect(credentials.connectionId).toBe("b");
  });

  it("leaves the pool untouched for an unbound key", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a"), conn("b")]);
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: "sk-free" });

    expect(credentials.connectionId).toBe("a");
  });

  it("reports no_active_credentials when the bound account is gone", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a")]);
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["missing"]);

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: "sk-bound" });

    expect(credentials.noActiveCredentials).toBe(true);
    expect(credentials.candidate.reason).toBe("no_active_credentials");
    expect(credentials.candidate.status).toBe(503);
  });
});

describe("account binding — quota tracker filter", () => {
  const request = (query) => new Request(`https://router.test/api/providers/client${query}`);

  beforeEach(() => {
    mocks.getProviderConnections.mockResolvedValue([conn("a"), conn("b")]);
  });

  it("narrows the listing to the key's accounts", async () => {
    mocks.getApiKeys.mockResolvedValue([{ id: "k1", name: "bound", allowedConnectionIds: ["b"] }]);

    const body = await (await providersClientGET(request("?apiKeyId=k1"))).json();

    expect(body.connections.map((c) => c.id)).toEqual(["b"]);
    expect(body.totals).toMatchObject({ eligibleConnections: 2, keyFilteredConnections: 1 });
  });

  it("shows everything for an unbound key", async () => {
    mocks.getApiKeys.mockResolvedValue([{ id: "k1", name: "free", allowedConnectionIds: null }]);

    const body = await (await providersClientGET(request("?apiKeyId=k1"))).json();

    expect(body.connections.map((c) => c.id)).toEqual(["a", "b"]);
    expect(body.apiKeyOptions).toEqual([{ id: "k1", name: "free", boundConnections: 0 }]);
  });
});
