import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getApiKeyRoutingContext: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  getDashboardAuthSession: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
  getApiKeyRoutingContext: mocks.getApiKeyRoutingContext,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

// A request that actually came through custom-server.js: peer IP stamped from the TCP
// socket and proven by the per-process secret.
function localRequest(pathname, headers = {}) {
  return request(pathname, { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: false, owner: null, kind: "usage" });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(localRequest("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(request("/codex/x", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote /responses rewrite without API key", async () => {
    const response = await proxy(request("/responses", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote /responses rewrite with a valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/responses", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/codex/x", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: false, owner: null, kind: "usage" });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(localRequest("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  // Mutation-proof for isAuthenticated() growing an adminKeyContext branch:
  // process-spawning/host-secret routes must stay session/CLI-token only, even
  // from the loopback socket, even with an otherwise-valid admin key.
  it("rejects local-only route on loopback with a valid admin key but no session", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: "alice@corp.com", kind: "admin" });

    const response = await proxy(localRequest("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
      authorization: "Bearer mgmt-key",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });

  it("extracts a management key from Authorization or x-api-key only — never query string or x-goog-api-key", () => {
    expect(__test__.extractManagementApiKey(
      request("/api/keys", { authorization: "Bearer mgmt-key" }),
    )).toBe("mgmt-key");
    expect(__test__.extractManagementApiKey(
      request("/api/keys", { "x-api-key": "mgmt-key" }),
    )).toBe("mgmt-key");
    expect(__test__.extractManagementApiKey(
      request("/api/keys?key=mgmt-key"),
    )).toBeNull();
    expect(__test__.extractManagementApiKey(
      request("/api/keys", { "x-goog-api-key": "mgmt-key" }),
    )).toBeNull();
  });
});

describe("dashboard guard admin API key access", () => {
  const OWNER = "alice@corp.com";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
  });

  it("allows a protected /api/* route with an active, owned, admin key", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: OWNER, kind: "admin" });

    const response = await proxy(request("/api/keys", { authorization: "Bearer admin-key" }));

    expect(response).toBe(mocks.nextResponse);
  });

  // Mutation-proof for a dropped/flipped `ctx.kind !== "admin"` check: only
  // this field differs from the passing case above.
  it("rejects an active, owned key with kind: usage", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: OWNER, kind: "usage" });

    const response = await proxy(request("/api/keys", { authorization: "Bearer routing-key" }));

    expect(response.status).toBe(401);
  });

  // Mutation-proof for a dropped `!ctx.owner` check: only owner differs from
  // the passing case above.
  it("rejects a shared (owner: null) key even with kind: admin", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: null, kind: "admin" });

    const response = await proxy(request("/api/keys", { authorization: "Bearer shared-admin-key" }));

    expect(response.status).toBe(401);
  });

  it("rejects an inactive, owned, admin key", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: false, owner: OWNER, kind: "admin" });

    const response = await proxy(request("/api/keys", { authorization: "Bearer inactive-admin-key" }));

    expect(response.status).toBe(401);
  });

  // Query-string admin key is a spec violation (G2e), not a hypothetical:
  // dashboardGuard's own extractApiKey does accept ?key=, so the middleware
  // gate must go through the header-only extractManagementApiKey instead.
  it("rejects an admin key presented only via the ?key= query string", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: OWNER, kind: "admin" });

    const response = await proxy(request("/api/keys?key=admin-key"));

    expect(response.status).toBe(401);
    expect(mocks.getApiKeyRoutingContext).not.toHaveBeenCalled();
  });

  it("never grants ALWAYS_PROTECTED access with an admin key", async () => {
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: OWNER, kind: "admin" });

    const response = await proxy(request("/api/shutdown", { authorization: "Bearer admin-key" }));

    expect(response.status).toBe(401);
  });

  it("an admin-owned admin key passes an ADMIN_ONLY_PATH when scoping is on", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, scopeResourcesByUser: true });
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: "@admin", kind: "admin" });

    const response = await proxy(request("/api/proxy-pools", { authorization: "Bearer super-admin-key" }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("a non-admin-owned admin key is rejected on an ADMIN_ONLY_PATH when scoping is on", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, scopeResourcesByUser: true });
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: OWNER, kind: "admin" });

    const response = await proxy(request("/api/proxy-pools", { authorization: "Bearer admin-key" }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Admin access required");
  });
});
