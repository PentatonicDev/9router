// Coverage for coordinateRefresh wired into GET /api/providers/[id]/models's
// buildOAuthResolver (src/app/api/providers/[id]/models/route.js) — same
// winner/loser contract as the executor call sites
// (tests/unit/oauth-refresh-coordinate-executors.test.js), verified here for
// the models-list OAuth resolver specifically.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshCodexToken: mocks.refreshCodexToken,
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

function freshConnection(overrides = {}) {
  return {
    id: "conn-codex-1",
    provider: "codex",
    accessToken: "stale-access-token",
    refreshToken: "stale-refresh-token",
    ...overrides,
  };
}

describe("GET /api/providers/[id]/models — codex OAuth resolver coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("does not call refreshFn when another holder owns the lease and the reloaded row is fresh", async () => {
    const { setRefreshCoordinator } = await import("open-sse/services/oauthCredentialManager.js");
    setRefreshCoordinator({
      claim: async () => ({ won: false, release: async () => {} }),
      reload: async () => ({
        connectionId: "conn-codex-1",
        accessToken: "already-fresh-access-token",
        refreshToken: "already-fresh-refresh-token",
        // Codex's refresh lead is 5 days (getRefreshLeadMs) — well past that —
        // and codex also proactively refreshes on lastRefreshAt staleness
        // (isCodexRefreshStale), so both need to look fresh.
        expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        lastRefreshAt: new Date().toISOString(),
      }),
    });

    mocks.getProviderConnectionById.mockResolvedValue(freshConnection());

    let call = 0;
    global.fetch = vi.fn(async (url, init) => {
      call++;
      // First call (stale token) 401s; the resolver should retry with the
      // reloaded token, never with a token from a real refreshFn call.
      if (call === 1) {
        return new Response("unauthorized", { status: 401 });
      }
      expect(init.headers.Authorization).toBe("Bearer already-fresh-access-token");
      return new Response(JSON.stringify({ data: [{ id: "gpt-5-codex" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await GET(new Request("http://localhost/api/providers/conn-codex-1/models"), {
      params: Promise.resolve({ id: "conn-codex-1" }),
    });
    const body = await res.json();

    expect(mocks.refreshCodexToken).not.toHaveBeenCalled();
    expect(call).toBe(2);
    expect(body.models.some((m) => m.id === "gpt-5-codex")).toBe(true);

    setRefreshCoordinator(null);
  });
});
