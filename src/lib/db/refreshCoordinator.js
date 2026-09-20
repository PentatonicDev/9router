// Cross-process OAuth refresh coordinator, installed into the DB-agnostic
// open-sse/services/oauthCredentialManager.js via setRefreshCoordinator() so
// two instances refreshing the same connection's token at once don't both hit
// the provider — the loser would submit an already-rotated (dead) refresh
// token and get invalid_grant. Backed by the generic jobLeases mutex
// (src/lib/db/leases.js), which already carries its own fail-open contract.
//
// One lease per connection (`oauth-refresh:<provider>:<connectionId>`), TTL
// 30s — a refresh call is seconds, not minutes, so renewal is unnecessary.
import { claimLease, releaseLease } from "./leases.js";
import { getProviderConnectionById } from "./index.js";

const LEASE_TTL_MS = 30_000;
const NOOP_RELEASE = async () => {};

function leaseId(provider, connectionId) {
  return `oauth-refresh:${provider}:${connectionId}`;
}

// Minimal subset of the connection→credentials mapping src/sse/services/auth.js's
// getProviderCredentials builds (selection/proxy fields omitted — irrelevant to a
// refresh freshness check or to mergeRefreshedCredentials' merge).
//
// Deliberately omits `expiresIn`: it's a relative seconds-from-refresh value
// that goes stale the moment time passes, but every consumer of a refreshed
// credentials object (updateProviderCredentials, checkAndRefreshToken,
// mergeRefreshedCredentials) treats a present `expiresIn` as the source of
// truth and recomputes `expiresAt = now + expiresIn` from it. Persisting this
// row's own stale `expiresIn` back would silently push a real, correct
// `expiresAt` further into the future. `expiresAt` alone is the authoritative,
// already-absolute value for a row that's just been read back from the DB.
function connectionToCredentials(connection) {
  if (!connection) return null;
  return {
    connectionId: connection.id,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    projectId: connection.projectId,
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
    providerSpecificData: connection.providerSpecificData || {},
  };
}

export function createDbRefreshCoordinator() {
  return {
    async claim(provider, credentials) {
      const connectionId = credentials?.connectionId;
      // Nothing to coordinate on (e.g. a test-only credentials object) — the
      // caller proceeds exactly as it would with no coordinator installed.
      if (!connectionId) return { won: true, release: NOOP_RELEASE };

      const id = leaseId(provider, connectionId);
      const holder = await claimLease(id, LEASE_TTL_MS);
      if (!holder) return { won: false, release: NOOP_RELEASE };
      return { won: true, release: () => releaseLease(id, holder) };
    },

    async reload(provider, credentials) {
      const connectionId = credentials?.connectionId;
      if (!connectionId) return null;
      try {
        return connectionToCredentials(await getProviderConnectionById(connectionId));
      } catch (e) {
        // Fail open: a reload failure means we can't tell whether the row is
        // already fresh, so the caller falls back to its default behaviour
        // (winner refreshes anyway; loser defers to the next tick/request).
        console.warn(`[DB][refreshCoordinator] reload("${connectionId}") failed: ${e.message}`);
        return null;
      }
    },
  };
}
