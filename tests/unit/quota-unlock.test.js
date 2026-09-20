import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

vi.mock("@/shared/constants/config", () => ({
  QUOTA_UNLOCK_CONFIG: { tickIntervalMs: 600000, minLockRemainingMs: 600000 },
}));

const NOW = new Date("2026-01-01T12:00:00.000Z");
const LONG_LOCK = new Date(NOW.getTime() + 125 * 3600 * 1000).toISOString();

function lockedCodex(overrides = {}) {
  return {
    id: "conn-1",
    provider: "codex",
    authType: "oauth",
    isActive: true,
    email: "eu@gilsonsouza.dev",
    testStatus: "unavailable",
    lastError: "The usage limit has been reached",
    errorCode: 429,
    backoffLevel: 0,
    "modelLock_gpt-5.6-sol": LONG_LOCK,
    ...overrides,
  };
}

function lockedKiro(overrides = {}) {
  return {
    id: "kiro-1",
    provider: "kiro",
    authType: "oauth",
    isActive: true,
    testStatus: "unavailable",
    lastError: '{"message":"You have reached the limit.","reason":"MONTHLY_REQUEST_COUNT"}',
    errorCode: 402,
    backoffLevel: 0,
    "modelLock___all": new Date(NOW.getTime() + 46 * 3600 * 1000).toISOString(),
    ...overrides,
  };
}

const FREE_QUOTAS = {
  quotas: {
    session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T15:59:00.000Z" },
    weekly: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-08T10:59:00.000Z" },
  },
};

// runQuotaUnlockTick now claims a real cross-instance lease (src/lib/db/leases.js)
// around its body, so it needs a real (throwaway) sqlite db instead of the
// mocked deps used for everything else here — never the real ~/.9router one.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let closeDb;

describe("quota unlock", () => {
  let buildQuotaUnlockUpdate;
  let runQuotaUnlockTick;
  let UNLOCK_LEASE_ID;
  let claimLease;
  let releaseLease;
  let deps;
  let state;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quota-unlock-"));
    process.env.DATA_DIR = tempDir;
    const kysely = await import("@/lib/db/kysely.js");
    closeDb = kysely.closeDb;
    await kysely.getDb(); // force schema creation before any test runs
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    delete global.__quotaUnlock;

    ({ buildQuotaUnlockUpdate } = await import("../../src/shared/services/quotaUnlockRules.js"));
    ({ runQuotaUnlockTick, UNLOCK_LEASE_ID } = await import("../../src/shared/services/quotaUnlock.js"));
    ({ claimLease, releaseLease } = await import("@/lib/db/leases.js"));

    deps = {
      getProviderConnections: vi.fn().mockResolvedValue([]),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      getUsageForProvider: vi.fn().mockResolvedValue(FREE_QUOTAS),
    };
    state = { running: false };
  });

  it("clears a long 429 lock when every quota window is free", () => {
    const update = buildQuotaUnlockUpdate(lockedCodex(), FREE_QUOTAS);

    expect(update).toMatchObject({
      "modelLock_gpt-5.6-sol": null,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      backoffLevel: 0,
    });
  });

  it("keeps the lock while any quota window is still exhausted", () => {
    const usage = {
      quotas: {
        session: { used: 0, total: 100, remaining: 100 },
        weekly: { used: 100, total: 100, remaining: 0 },
      },
    };

    expect(buildQuotaUnlockUpdate(lockedCodex(), usage)).toBeNull();
  });

  it("keeps the lock when the provider reports no quota at all", () => {
    expect(buildQuotaUnlockUpdate(lockedCodex(), { message: "Usage API temporarily unavailable" })).toBeNull();
    expect(buildQuotaUnlockUpdate(lockedCodex(), { quotas: {} })).toBeNull();
  });

  it("ignores short backoff locks and non-quota errors", () => {
    const shortLock = lockedCodex({ "modelLock_gpt-5.6-sol": new Date(NOW.getTime() + 60000).toISOString() });
    expect(buildQuotaUnlockUpdate(shortLock, FREE_QUOTAS)).toBeNull();

    const authError = lockedCodex({ errorCode: 401, lastError: "invalid_grant" });
    expect(buildQuotaUnlockUpdate(authError, FREE_QUOTAS)).toBeNull();
  });

  it("ignores connections without an active lock", () => {
    const expired = lockedCodex({ "modelLock_gpt-5.6-sol": new Date(NOW.getTime() - 1000).toISOString() });
    expect(buildQuotaUnlockUpdate(expired, FREE_QUOTAS)).toBeNull();
    expect(buildQuotaUnlockUpdate(lockedCodex({ "modelLock_gpt-5.6-sol": null }), FREE_QUOTAS)).toBeNull();
  });

  it("clears a Kiro monthly-limit lock once the credit window refills", () => {
    const exhausted = { quotas: { credit: { used: 50, total: 50, remaining: 0, resetAt: "2026-01-03T10:56:00.000Z" } } };
    expect(buildQuotaUnlockUpdate(lockedKiro(), exhausted)).toBeNull();

    const refilled = { quotas: { credit: { used: 0, total: 50, remaining: 50, resetAt: "2026-02-01T10:56:00.000Z" } } };
    expect(buildQuotaUnlockUpdate(lockedKiro(), refilled)).toMatchObject({
      "modelLock___all": null,
      testStatus: "active",
      errorCode: null,
    });
  });

  it("does not let an allowance-less window (expired free trial) pin Kiro down", () => {
    const usage = {
      quotas: {
        credit: { used: 0, total: 50, remaining: 50, resetAt: "2026-02-01T10:56:00.000Z" },
        credit_freetrial: { used: 0, total: 0, remaining: 0, resetAt: "2026-02-01T10:56:00.000Z" },
      },
    };

    expect(buildQuotaUnlockUpdate(lockedKiro(), usage)).not.toBeNull();
  });

  it("only spends a usage call on locked connections", async () => {
    deps.getProviderConnections.mockResolvedValue([
      lockedCodex(),
      { id: "conn-2", provider: "claude", authType: "oauth", isActive: true, testStatus: "active" },
    ]);

    await runQuotaUnlockTick(deps, state);

    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      "modelLock_gpt-5.6-sol": null,
      testStatus: "active",
    }));
  });

  it("survives a failing connection and keeps reconciling the others", async () => {
    deps.getProviderConnections.mockResolvedValue([
      lockedCodex({ id: "boom" }),
      lockedCodex({ id: "conn-1" }),
    ]);
    deps.getUsageForProvider.mockRejectedValueOnce(new Error("network down"));

    await runQuotaUnlockTick(deps, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.anything());
  });

  describe("cross-instance lease", () => {
    beforeEach(() => {
      deps.getProviderConnections.mockResolvedValue([lockedCodex()]);
    });

    it("skips entirely when another instance already holds the lease", async () => {
      const foreignHolder = await claimLease(UNLOCK_LEASE_ID, 60_000, { holder: "other-instance:1" });
      expect(foreignHolder).toBe("other-instance:1");

      try {
        await runQuotaUnlockTick(deps, state);

        expect(deps.getProviderConnections).not.toHaveBeenCalled();
        expect(deps.getUsageForProvider).not.toHaveBeenCalled();
        expect(deps.updateProviderConnection).not.toHaveBeenCalled();
      } finally {
        await releaseLease(UNLOCK_LEASE_ID, "other-instance:1");
      }
    });

    it("runs and releases the lease when free, so a subsequent claim wins", async () => {
      await runQuotaUnlockTick(deps, state);

      expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);

      const next = await claimLease(UNLOCK_LEASE_ID, 60_000, { holder: "next-claimant" });
      expect(next).toBe("next-claimant");
      await releaseLease(UNLOCK_LEASE_ID, "next-claimant");
    });

    it("stops the loop instead of double-processing once another instance steals the lease mid-run", async () => {
      deps.getProviderConnections.mockResolvedValue([lockedCodex({ id: "conn-1" }), lockedCodex({ id: "conn-2" })]);
      // Simulate the lease outliving its TTL mid-loop (clock skew / a slow
      // reconcile) and a rival instance winning the now-expired row while
      // conn-1 is still being reconciled — renew() for conn-2 must then see
      // it no longer owns the lease.
      deps.getUsageForProvider.mockImplementationOnce(async (...args) => {
        vi.setSystemTime(new Date(NOW.getTime() + 700_000));
        const rival = await claimLease(UNLOCK_LEASE_ID, 60_000, { holder: "rival-instance" });
        expect(rival).toBe("rival-instance");
        return FREE_QUOTAS;
      });

      try {
        await runQuotaUnlockTick(deps, state);

        expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
        expect(deps.updateProviderConnection).toHaveBeenCalledTimes(1);
        expect(deps.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.anything());
      } finally {
        await releaseLease(UNLOCK_LEASE_ID, "rival-instance");
      }
    });
  });
});
