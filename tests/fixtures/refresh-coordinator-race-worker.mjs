// Spawned as a separate OS process by
// tests/unit/refresh-coordinator-two-process.test.js — real inter-process
// contention on the DB-backed refresh coordinator (src/lib/db/refreshCoordinator.js),
// installed into open-sse/services/oauthCredentialManager.js exactly as
// src/instrumentation.js does at boot. Two of these race to refresh the same
// connectionId; the assertion (in the test) is that only one of them ever
// calls the mocked provider endpoint, and both end up holding the new token —
// the loser via reload() after the winner persists, mirroring how
// checkAndRefreshToken persists a refresh result in production.
import fs from "node:fs";

const [, , dataDir, connectionId, outFile] = process.argv;
process.env.DATA_DIR = dataDir;

let fetchCallCount = 0;
const NEW_ACCESS_TOKEN = "new-access-token";
const NEW_REFRESH_TOKEN = "new-refresh-token";
// Well beyond claude's refresh lead (4h) so a fresh reload is recognized as
// "no longer needs refresh" instead of immediately re-triggering another call.
const EXPIRES_IN = 24 * 60 * 60;

global.fetch = async () => {
  fetchCallCount++;
  // Small artificial delay so both processes are likely mid-flight together
  // instead of trivially serializing through OS scheduling alone.
  await new Promise((r) => setTimeout(r, 40));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      expires_in: EXPIRES_IN,
    }),
    text: async () => "",
  };
};

const { setRefreshCoordinator, refreshProviderCredentials } = await import(
  "open-sse/services/oauthCredentialManager.js"
);
const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
const { refreshWithRetry } = await import("open-sse/services/tokenRefresh.js");
const { updateProviderConnection } = await import("@/lib/db/index.js");

setRefreshCoordinator(createDbRefreshCoordinator());

const credentials = {
  connectionId,
  refreshToken: "old-refresh-token",
  accessToken: "old-access-token",
  // Already stale, so shouldRefreshCredentials() is true from the start.
  expiresAt: new Date(Date.now() - 1000).toISOString(),
};

const result = await refreshWithRetry(async () => {
  const before = fetchCallCount;
  const out = await refreshProviderCredentials("claude", credentials, null);
  if (out?.accessToken && fetchCallCount > before) {
    // This call is the one that actually hit the provider — persist, exactly
    // like src/sse/services/tokenRefresh.js's checkAndRefreshToken does after
    // a real refresh, so the loser's reload() can observe the new token.
    await updateProviderConnection(connectionId, {
      accessToken: out.accessToken,
      refreshToken: out.refreshToken,
      expiresAt: out.expiresAt,
    });
  }
  return out;
}, 5, null);

fs.writeFileSync(outFile, JSON.stringify({ fetchCallCount, accessToken: result?.accessToken || null }));
