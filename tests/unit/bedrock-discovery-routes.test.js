// POST /api/providers/bedrock/discover (preview, pre-connection) and
// POST /api/providers/[id]/discover (existing connection). Both sit behind
// the normal /api guard (dashboardGuard's deny-by-default for /api/*, proven
// directly against the real guard below) and owner scoping via canSee, like
// every other /api/providers/[id] route.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getScopeFilter: vi.fn(),
  updateProviderCredentials: vi.fn(),
  resolveBedrockModels: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/auth/resourceScope", async () => {
  const actual = await vi.importActual("@/lib/auth/resourceScope");
  return { ...actual, getScopeFilter: mocks.getScopeFilter };
});

vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("open-sse/services/bedrockModels.js", () => ({
  resolveBedrockModels: mocks.resolveBedrockModels,
}));

const { POST: discoverPreview } = await import("../../src/app/api/providers/bedrock/discover/route.js");
const { POST: discoverById } = await import("../../src/app/api/providers/[id]/discover/route.js");

function postJson(body) {
  return new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
}

const discoveryResult = { at: "2026-01-01T00:00:00.000Z", region: "us-east-1", mode: "region", items: [{ id: "anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5", vendor: "Anthropic", kind: "model", access: "granted", streaming: true }], errors: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getScopeFilter.mockResolvedValue(null); // scoping disabled by default
  mocks.resolveBedrockModels.mockResolvedValue(discoveryResult);
});

describe("POST /api/providers/bedrock/discover — preview", () => {
  it("calls discovery with the submitted credentials and never persists", async () => {
    const res = await discoverPreview(postJson({
      apiKey: "bearer-secret",
      providerSpecificData: { authMethod: "api_key", region: "us-east-1" },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.discovery).toEqual(discoveryResult);
    expect(mocks.resolveBedrockModels).toHaveBeenCalledWith({
      apiKey: "bearer-secret",
      providerSpecificData: { authMethod: "api_key", region: "us-east-1" },
    });
    expect(mocks.updateProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
  });

  it("tolerates a missing providerSpecificData in the preview body", async () => {
    const res = await discoverPreview(postJson({ apiKey: "x" }));
    expect(res.status).toBe(200);
    expect(mocks.resolveBedrockModels).toHaveBeenCalledWith({ apiKey: "x", providerSpecificData: {} });
  });
});

describe("POST /api/providers/[id]/discover — existing connection", () => {
  const bedrockConnection = (overrides = {}) => ({
    id: "conn-1",
    provider: "bedrock",
    apiKey: "bearer-secret",
    providerSpecificData: { authMethod: "api_key", region: "us-east-1" },
    owner: null,
    ...overrides,
  });

  it("404s when the connection does not exist", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);
    const res = await discoverById(postJson({}), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
    expect(mocks.resolveBedrockModels).not.toHaveBeenCalled();
  });

  it("404s (owner scoping) when the connection belongs to a different owner", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(bedrockConnection({ owner: "someone-else@example.com" }));
    mocks.getScopeFilter.mockResolvedValue({ owner: "me@example.com" });
    const res = await discoverById(postJson({}), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(404);
  });

  it("succeeds when scoping is enabled and the caller owns the connection", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(bedrockConnection({ owner: "me@example.com" }));
    mocks.getScopeFilter.mockResolvedValue({ owner: "me@example.com" });
    const res = await discoverById(postJson({}), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(200);
  });

  it("400s for a non-bedrock connection", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(bedrockConnection({ provider: "openai" }));
    const res = await discoverById(postJson({}), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(400);
    expect(mocks.resolveBedrockModels).not.toHaveBeenCalled();
  });

  it("forceRefreshes discovery and persists providerSpecificData.discoveredModels", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(bedrockConnection());
    const res = await discoverById(postJson({}), { params: Promise.resolve({ id: "conn-1" }) });

    expect(res.status).toBe(200);
    expect(mocks.resolveBedrockModels).toHaveBeenCalledWith(
      { apiKey: "bearer-secret", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } },
      { forceRefresh: true },
    );
    expect(mocks.updateProviderCredentials).toHaveBeenCalledWith("conn-1", {
      providerSpecificData: {
        discoveredModels: { at: discoveryResult.at, items: discoveryResult.items, errors: discoveryResult.errors },
      },
      existingProviderSpecificData: { authMethod: "api_key", region: "us-east-1" },
    });
    const body = await res.json();
    expect(body.discovery).toEqual(discoveryResult);
  });
});

describe("both discover routes — 401 without auth", () => {
  // Exercises the real gate every non-public /api/* route sits behind
  // (dashboardGuard.js: deny-by-default for /api/*) against these exact new
  // paths, proving neither was added to any public/admin bypass list.
  it("rejects an unauthenticated request to both new paths", async () => {
    vi.resetModules();
    vi.doMock("@/lib/localDb", () => ({
      getSettings: vi.fn().mockResolvedValue({ requireLogin: true }),
      validateApiKey: vi.fn().mockResolvedValue(false),
      getApiKeyRoutingContext: vi.fn().mockResolvedValue({ valid: false, owner: null, kind: "usage" }),
    }));
    vi.doMock("@/shared/utils/machineId", () => ({
      getConsistentMachineId: vi.fn().mockResolvedValue("cli-token-fixture"),
    }));
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      verifyDashboardAuthToken: vi.fn().mockResolvedValue(false),
      getDashboardAuthSession: vi.fn().mockResolvedValue(null),
    }));

    const { proxy } = await import("../../src/dashboardGuard.js");

    function request(pathname) {
      return {
        nextUrl: { pathname, searchParams: new URLSearchParams() },
        headers: new Headers(),
        cookies: { get: () => undefined },
        url: `http://localhost${pathname}`,
      };
    }

    const previewRes = await proxy(request("/api/providers/bedrock/discover"));
    expect(previewRes.status).toBe(401);

    const byIdRes = await proxy(request("/api/providers/conn-1/discover"));
    expect(byIdRes.status).toBe(401);

    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/shared/utils/machineId");
    vi.doUnmock("@/lib/auth/dashboardSession");
  });
});
