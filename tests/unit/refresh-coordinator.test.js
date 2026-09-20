// Single-process coverage for the OAuth refresh coordinator hook
// (open-sse/services/oauthCredentialManager.js's setRefreshCoordinator +
// src/lib/db/refreshCoordinator.js). The real cross-process race is covered by
// tests/unit/refresh-coordinator-two-process.test.js; this file covers the
// contract pieces that don't need two OS processes: the loser never waiting,
// an unrecoverable provider error surfacing as a real failure instead of a
// silent null, and identical behaviour when no coordinator is installed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = global.fetch;
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let closeDb;

function mockFetchOnce(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
  global.fetch = fn;
  return fn;
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-refresh-coordinator-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const kysely = await import("@/lib/db/kysely.js");
  closeDb = kysely.closeDb;
  await kysely.getDb();
});

afterAll(async () => {
  await closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function seedConnection(overrides = {}) {
  const { createProviderConnection } = await import("@/lib/db/index.js");
  return createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: `${Math.random().toString(36).slice(2)}@example.com`,
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  });
}

describe("createDbRefreshCoordinator", () => {
  it("claim() wins immediately when nothing else holds the lease, and releases cleanly", async () => {
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    const coordinator = createDbRefreshCoordinator();
    const connection = await seedConnection();

    const claim = await coordinator.claim("claude", { connectionId: connection.id });
    expect(claim.won).toBe(true);
    await claim.release();

    // Released — a second claim can win again right away.
    const claim2 = await coordinator.claim("claude", { connectionId: connection.id });
    expect(claim2.won).toBe(true);
    await claim2.release();
  });

  it("claim() loses while another holder's lease is still live, and reload() reflects the DB row", async () => {
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    const { claimLease, releaseLease } = await import("@/lib/db/leases.js");
    const coordinator = createDbRefreshCoordinator();
    const connection = await seedConnection();
    const leaseId = `oauth-refresh:claude:${connection.id}`;

    const otherHolder = await claimLease(leaseId, 30_000, { holder: "other-instance" });
    expect(otherHolder).toBe("other-instance");

    const claim = await coordinator.claim("claude", { connectionId: connection.id });
    expect(claim.won).toBe(false);

    const reloaded = await coordinator.reload("claude", { connectionId: connection.id });
    expect(reloaded.accessToken).toBe("old-access-token");

    await releaseLease(leaseId, "other-instance");
  });

  it("claim() with no connectionId has nothing to coordinate on and always wins", async () => {
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    const coordinator = createDbRefreshCoordinator();
    const claim = await coordinator.claim("claude", {});
    expect(claim.won).toBe(true);
    expect(await coordinator.reload("claude", {})).toBeNull();
  });
});

describe("refreshProviderCredentials with a coordinator installed", () => {
  it("loser returns null immediately (never waits) when the winner hasn't persisted yet", async () => {
    // Captured directly: something down oauthCredentialManager's import chain
    // (open-sse's proxy-aware fetch patch) wraps whatever global.fetch is at
    // import time, so asserting on global.fetch itself would check the
    // wrapper, not this mock.
    const fetchMock = mockFetchOnce({ access_token: "should-not-be-used" });
    const { setRefreshCoordinator, refreshProviderCredentials } = await import(
      "open-sse/services/oauthCredentialManager.js"
    );
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    const { claimLease, releaseLease } = await import("@/lib/db/leases.js");
    setRefreshCoordinator(createDbRefreshCoordinator());

    const connection = await seedConnection();
    const leaseId = `oauth-refresh:claude:${connection.id}`;
    await claimLease(leaseId, 30_000, { holder: "other-instance" });

    const started = Date.now();
    const result = await refreshProviderCredentials("claude", {
      connectionId: connection.id,
      refreshToken: "old-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, null);
    const elapsedMs = Date.now() - started;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(500); // no retry/backoff loop inside a single call
    expect(fetchMock).not.toHaveBeenCalled(); // never sends a (possibly stale) token upstream

    await releaseLease(leaseId, "other-instance");
    setRefreshCoordinator(null);
  });

  it("winner reload()s a row that's already fresh and skips calling the provider", async () => {
    const fetchMock = mockFetchOnce({ access_token: "should-not-be-used" });
    const { setRefreshCoordinator, refreshProviderCredentials } = await import(
      "open-sse/services/oauthCredentialManager.js"
    );
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    setRefreshCoordinator(createDbRefreshCoordinator());

    // A previous winner already refreshed and persisted a token that's fresh
    // for far longer than claude's refresh lead (4h).
    const connection = await seedConnection({
      accessToken: "already-fresh-access-token",
      refreshToken: "already-fresh-refresh-token",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // Caller's in-memory credentials are stale (as if read before the other
    // winner's write) — the coordinator's reload() must catch that.
    const result = await refreshProviderCredentials("claude", {
      connectionId: connection.id,
      refreshToken: "old-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("already-fresh-access-token");

    setRefreshCoordinator(null);
  });

  it("an unrecoverable provider error is not persisted and stops refreshWithRetry after one attempt", async () => {
    const fetchMock = mockFetchOnce({ error: "invalid_grant" }, { ok: false, status: 400 });
    const { setRefreshCoordinator, refreshProviderCredentials } = await import(
      "open-sse/services/oauthCredentialManager.js"
    );
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    const { refreshWithRetry } = await import("open-sse/services/tokenRefresh.js");
    setRefreshCoordinator(createDbRefreshCoordinator());

    const connection = await seedConnection();
    const credentials = {
      connectionId: connection.id,
      refreshToken: "old-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };

    const result = await refreshWithRetry(
      () => refreshProviderCredentials("claude", credentials, null),
      3,
      null
    );

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry storm against a dead refresh token
    expect(result).toEqual(expect.objectContaining({ error: "unrecoverable_refresh_error" }));
    // Mirrors checkAndRefreshToken's persistence guard: nothing worth writing.
    expect(result.accessToken || result.apiKey || result.copilotToken).toBeFalsy();

    const stillOld = await (await import("@/lib/db/index.js")).getProviderConnectionById(connection.id);
    expect(stillOld.accessToken).toBe("old-access-token");

    setRefreshCoordinator(null);
  });
});

describe("coordinateRefresh winner path uses the reloaded row, not the stale caller credentials", () => {
  it("calls refreshFn with reload()'s refreshToken when the row still needs refresh but was rotated by another instance", async () => {
    const fetchMock = mockFetchOnce({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    const { setRefreshCoordinator, refreshProviderCredentials } = await import(
      "open-sse/services/oauthCredentialManager.js"
    );

    // Fake coordinator: always wins the claim, and reload() returns a row that
    // still needs refreshing (expired) but carries a refresh token rotated by
    // another instance minutes ago — different from the caller's stale one.
    setRefreshCoordinator({
      claim: async () => ({ won: true, release: async () => {} }),
      reload: async () => ({
        connectionId: "conn-1",
        accessToken: "mid-access-token",
        refreshToken: "rotated-by-other-instance",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    });

    const result = await refreshProviderCredentials("claude", {
      connectionId: "conn-1",
      accessToken: "very-stale-access-token",
      refreshToken: "very-stale-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, null);

    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = requestInit.body?.toString?.() ?? "";
    expect(sentBody).toContain("rotated-by-other-instance");
    expect(sentBody).not.toContain("very-stale-refresh-token");
    expect(result.accessToken).toBe("new-access");

    setRefreshCoordinator(null);
  });
});

describe("refreshWithRetry treats a loser's adopted fresh token as success (no retry storm)", () => {
  it("stops after one attempt and returns the adopted credentials when the loser's reload is already fresh", async () => {
    const fetchMock = mockFetchOnce({ access_token: "should-not-be-used" });
    const { setRefreshCoordinator, refreshProviderCredentials } = await import(
      "open-sse/services/oauthCredentialManager.js"
    );
    const { refreshWithRetry } = await import("open-sse/services/tokenRefresh.js");

    setRefreshCoordinator({
      claim: async () => ({ won: false, release: async () => {} }),
      reload: async () => ({
        connectionId: "conn-1",
        accessToken: "already-fresh-access-token",
        refreshToken: "already-fresh-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    });

    const started = Date.now();
    const result = await refreshWithRetry(
      () => refreshProviderCredentials("claude", { connectionId: "conn-1", refreshToken: "stale" }, null),
      3,
      null
    );
    const elapsedMs = Date.now() - started;

    expect(result.accessToken).toBe("already-fresh-access-token");
    expect(elapsedMs).toBeLessThan(500); // 1st attempt succeeds — no backoff/retry loop
    expect(fetchMock).not.toHaveBeenCalled();

    setRefreshCoordinator(null);
  });
});

describe("refreshProviderCredentials with no coordinator installed", () => {
  it("behaves exactly as before — straight refresh, no lease involved", async () => {
    const fetchMock = mockFetchOnce({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    const { refreshProviderCredentials } = await import("open-sse/services/oauthCredentialManager.js");

    const result = await refreshProviderCredentials("claude", {
      connectionId: "no-coordinator-conn",
      refreshToken: "old-refresh-token",
    }, null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("new-access");
  });
});
