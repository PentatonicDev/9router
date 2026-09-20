// Coverage for coordinateRefresh wired into the executor refresh call sites
// (open-sse/executors/default.js, open-sse/executors/kiro.js) — the reactive
// 401/403 path in chatCore.js goes through executor.refreshCredentials(), so
// these must honour the same winner/loser contract as
// oauthCredentialManager.js's refreshProviderCredentials (covered by
// tests/unit/refresh-coordinator.test.js), while still returning the raw
// provider-shaped result chatCore's Object.assign(credentials, result) and
// updateProviderCredentials expect.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function freshRow(overrides = {}) {
  return {
    connectionId: "conn-1",
    accessToken: "fresh-access-token",
    refreshToken: "fresh-refresh-token",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    providerSpecificData: {},
    ...overrides,
  };
}

function staleRow(overrides = {}) {
  return {
    connectionId: "conn-1",
    accessToken: "stale-access-token",
    refreshToken: "stale-refresh-token",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    providerSpecificData: {},
    ...overrides,
  };
}

describe("DefaultExecutor.refreshCredentials with a coordinator installed (provider: claude)", () => {
  it("winner: calls the provider once, with proxyOptions preserved", async () => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const { setRefreshCoordinator } = await import("open-sse/services/oauthCredentialManager.js");
    const grantSpy = vi
      .spyOn(DefaultExecutor.prototype, "refreshFromGrant")
      .mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });

    setRefreshCoordinator({
      claim: async () => ({ won: true, release: async () => {} }),
      reload: async () => staleRow({ refreshToken: "reloaded-refresh-token" }),
    });

    const executor = new DefaultExecutor("claude");
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:8080" };
    const result = await executor.refreshCredentials(
      { connectionId: "conn-1", refreshToken: "outer-stale-refresh-token" },
      null,
      proxyOptions
    );

    expect(grantSpy).toHaveBeenCalledTimes(1);
    expect(grantSpy).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "reloaded-refresh-token" }),
      proxyOptions
    );
    expect(result.accessToken).toBe("new-access");

    setRefreshCoordinator(null);
  });

  it("loser + fresh row: refresher not called, returned object carries the reloaded accessToken", async () => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const { setRefreshCoordinator } = await import("open-sse/services/oauthCredentialManager.js");
    const grantSpy = vi.spyOn(DefaultExecutor.prototype, "refreshFromGrant");

    setRefreshCoordinator({
      claim: async () => ({ won: false, release: async () => {} }),
      reload: async () => freshRow({ accessToken: "already-fresh-access-token" }),
    });

    const executor = new DefaultExecutor("claude");
    const result = await executor.refreshCredentials(
      { connectionId: "conn-1", refreshToken: "outer-stale-refresh-token" },
      null
    );

    expect(grantSpy).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("already-fresh-access-token");

    setRefreshCoordinator(null);
  });

  it("loser + stale row: returns null", async () => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const { setRefreshCoordinator } = await import("open-sse/services/oauthCredentialManager.js");
    const grantSpy = vi.spyOn(DefaultExecutor.prototype, "refreshFromGrant");

    setRefreshCoordinator({
      claim: async () => ({ won: false, release: async () => {} }),
      reload: async () => staleRow(),
    });

    const executor = new DefaultExecutor("claude");
    const result = await executor.refreshCredentials(
      { connectionId: "conn-1", refreshToken: "outer-stale-refresh-token" },
      null
    );

    expect(grantSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();

    setRefreshCoordinator(null);
  });
});

describe("KiroExecutor.refreshCredentials with a coordinator installed", () => {
  it("winner: calls refreshKiroToken once with the reloaded refresh token", async () => {
    vi.doMock("open-sse/services/tokenRefresh.js", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, refreshKiroToken: vi.fn().mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }) };
    });
    const { KiroExecutor } = await import("open-sse/executors/kiro.js");
    const { refreshKiroToken } = await import("open-sse/services/tokenRefresh.js");
    const { setRefreshCoordinator } = await import("open-sse/services/oauthCredentialManager.js");

    setRefreshCoordinator({
      claim: async () => ({ won: true, release: async () => {} }),
      reload: async () => staleRow({ refreshToken: "reloaded-refresh-token" }),
    });

    const executor = new KiroExecutor("kiro");
    const result = await executor.refreshCredentials(
      { connectionId: "conn-1", refreshToken: "outer-stale-refresh-token" },
      null
    );

    expect(refreshKiroToken).toHaveBeenCalledTimes(1);
    expect(refreshKiroToken).toHaveBeenCalledWith("reloaded-refresh-token", {}, null, null);
    expect(result.accessToken).toBe("new-access");

    setRefreshCoordinator(null);
    vi.doUnmock("open-sse/services/tokenRefresh.js");
  });

  it("loser + fresh row: refresher not called, returned object carries the reloaded accessToken", async () => {
    vi.doMock("open-sse/services/tokenRefresh.js", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, refreshKiroToken: vi.fn() };
    });
    const { KiroExecutor } = await import("open-sse/executors/kiro.js");
    const { refreshKiroToken } = await import("open-sse/services/tokenRefresh.js");
    const { setRefreshCoordinator } = await import("open-sse/services/oauthCredentialManager.js");

    setRefreshCoordinator({
      claim: async () => ({ won: false, release: async () => {} }),
      reload: async () => freshRow({ accessToken: "already-fresh-access-token" }),
    });

    const executor = new KiroExecutor("kiro");
    const result = await executor.refreshCredentials(
      { connectionId: "conn-1", refreshToken: "outer-stale-refresh-token" },
      null
    );

    expect(refreshKiroToken).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("already-fresh-access-token");

    setRefreshCoordinator(null);
    vi.doUnmock("open-sse/services/tokenRefresh.js");
  });
});
