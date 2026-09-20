// Proves the specific corruption risk coordinateRefresh's skip/adopt branches
// must avoid: persisting a coordinator-reloaded row back through
// updateProviderCredentials (src/sse/services/tokenRefresh.js:163) — exactly
// what src/sse/handlers/chat.js's onCredentialsRefreshed does with whatever
// executor.refreshCredentials() returned — must be a no-op, not a clobber.
// The specific failure mode: a row can carry a stale `expiresIn` (relative
// seconds from whenever it was last actually refreshed); updateProviderCredentials
// (and mergeRefreshedCredentials, and checkAndRefreshToken) all treat a present
// `expiresIn` as authoritative and recompute `expiresAt = now + expiresIn` —
// silently pushing a real, correct `expiresAt` further into the future.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let closeDb;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reloaded-persist-"));
  process.env.DATA_DIR = tempDir;
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
  // Nothing to reset — this suite talks to the real repo functions, not
  // oauthCredentialManager's module-level coordinator singleton.
});

describe("persisting a reloaded row back to the DB", () => {
  it("is a no-op on the meaningful fields, even when the row carries a stale expiresIn", async () => {
    const { createProviderConnection, getProviderConnectionById } = await import("@/lib/db/index.js");
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh.js");

    // A row refreshed a while ago: expiresAt is the real, correct, still-in-the-
    // future expiry; expiresIn=3600 is the stale relative value from that
    // refresh, long meaningless by the time this row is reloaded.
    const connection = await createProviderConnection({
      provider: "claude",
      authType: "oauth",
      email: `${Math.random().toString(36).slice(2)}@example.com`,
      accessToken: "current-access-token",
      refreshToken: "current-refresh-token",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      expiresIn: 3600,
      lastRefreshAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      providerSpecificData: { someFlag: true },
    });

    const before = await getProviderConnectionById(connection.id);

    // Exactly what coordinateRefresh's skip/adopt branches return, and exactly
    // what chat.js's onCredentialsRefreshed persists it with.
    const coordinator = createDbRefreshCoordinator();
    const reloaded = await coordinator.reload("claude", { connectionId: connection.id });
    expect(reloaded.accessToken).toBe("current-access-token");

    await updateProviderCredentials(connection.id, {
      ...reloaded,
      existingProviderSpecificData: before.providerSpecificData,
      testStatus: "active",
    });

    const after = await getProviderConnectionById(connection.id);

    expect(after.accessToken).toBe(before.accessToken);
    expect(after.refreshToken).toBe(before.refreshToken);
    // The bug this guards against: expiresAt must NOT have been pushed further
    // into the future by re-deriving it from the stale expiresIn.
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.lastRefreshAt).toBe(before.lastRefreshAt);
    expect(after.providerSpecificData).toEqual(before.providerSpecificData);
    // Only an updatedAt-style bookkeeping field is expected to move.
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
  });
});
