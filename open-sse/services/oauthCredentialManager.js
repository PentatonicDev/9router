import {
  getRefreshLeadMs,
  isUnrecoverableRefreshError,
  refreshTokenByProvider,
} from "./tokenRefresh.js";
import { PROVIDER_OAUTH } from "../providers/index.js";

// Single source: codex.oauth.maxRefreshAgeMs (8 days) — proactive refresh window
export const CODEX_MAX_REFRESH_AGE_MS = PROVIDER_OAUTH["codex"]?.maxRefreshAgeMs;

const refreshLocks = new Map();

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toExpiresAt(expiresIn, nowMs = Date.now()) {
  if (!expiresIn) return null;
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

export function getCredentialExpiryMs(credentials) {
  return parseTimeMs(credentials?.expiresAt ?? credentials?.tokenExpiresAt);
}

export function getCredentialLastRefreshMs(credentials) {
  return parseTimeMs(
    credentials?.lastRefreshAt ??
    credentials?.lastRefresh ??
    credentials?.providerSpecificData?.lastRefreshAt
  );
}

export function isCodexRefreshStale(credentials, nowMs = Date.now(), maxAgeMs = CODEX_MAX_REFRESH_AGE_MS) {
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  return !lastRefreshMs || nowMs - lastRefreshMs >= maxAgeMs;
}

export function shouldRefreshCredentials(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return false;

  const expiresAtMs = getCredentialExpiryMs(credentials);
  if (expiresAtMs !== null && expiresAtMs - nowMs < getRefreshLeadMs(provider)) {
    return true;
  }

  // Proactive stale refresh for providers declaring oauth.maxRefreshAgeMs (e.g. codex)
  const maxAgeMs = PROVIDER_OAUTH[provider]?.maxRefreshAgeMs;
  if (maxAgeMs && credentials.refreshToken && isCodexRefreshStale(credentials, nowMs, maxAgeMs)) {
    return true;
  }

  return false;
}

export function mergeProviderSpecificData(existing, next) {
  if (!next || typeof next !== "object") return existing;
  return {
    ...(existing || {}),
    ...next,
  };
}

export function mergeRefreshedCredentials(provider, currentCredentials, refreshedCredentials, nowMs = Date.now()) {
  if (!refreshedCredentials) return null;
  if (isUnrecoverableRefreshError(refreshedCredentials)) return refreshedCredentials;
  // Recoverable failure (transient HTTP 5xx/429/etc.): let refreshWithRetry retry,
  // same as before toRefreshErrorResult started returning a truthy object here.
  if (refreshedCredentials.error) return null;

  const next = {};
  const nowIso = new Date(nowMs).toISOString();

  if (refreshedCredentials.accessToken) next.accessToken = refreshedCredentials.accessToken;
  if (refreshedCredentials.apiKey) next.apiKey = refreshedCredentials.apiKey;
  if (refreshedCredentials.token) next.token = refreshedCredentials.token;

  const refreshToken = refreshedCredentials.refreshToken ?? currentCredentials?.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;

  const idToken = refreshedCredentials.idToken ?? currentCredentials?.idToken;
  if (idToken) next.idToken = idToken;

  if (refreshedCredentials.expiresIn) {
    next.expiresIn = refreshedCredentials.expiresIn;
    next.expiresAt = toExpiresAt(refreshedCredentials.expiresIn, nowMs);
  } else if (refreshedCredentials.expiresAt) {
    next.expiresAt = refreshedCredentials.expiresAt;
  }

  if (refreshedCredentials.projectId) next.projectId = refreshedCredentials.projectId;

  if (refreshedCredentials.providerSpecificData) {
    next.providerSpecificData = mergeProviderSpecificData(
      currentCredentials?.providerSpecificData,
      refreshedCredentials.providerSpecificData
    );
  }

  if (refreshedCredentials.copilotToken) next.copilotToken = refreshedCredentials.copilotToken;
  if (refreshedCredentials.copilotTokenExpiresAt) {
    next.copilotTokenExpiresAt = refreshedCredentials.copilotTokenExpiresAt;
  }

  // trackRefreshAt providers (e.g. codex) always stamp lastRefreshAt for staleness tracking
  if (
    PROVIDER_OAUTH[provider]?.trackRefreshAt ||
    next.accessToken ||
    next.apiKey ||
    next.token ||
    next.refreshToken ||
    next.copilotToken
  ) {
    next.lastRefreshAt = refreshedCredentials.lastRefreshAt || nowIso;
  }

  return next;
}

// DB-backed cross-process coordinator, installed by src/instrumentation.js at
// boot via setRefreshCoordinator(). null by default so open-sse stays
// DB-agnostic and unit tests that never install one keep today's behaviour.
let _refreshCoordinator = null;

/**
 * @param {{ claim: (provider: string, credentials: object) => Promise<{won: boolean, release: () => Promise<void>}>,
 *           reload: (provider: string, credentials: object) => Promise<object|null> } | null} coordinator
 */
export function setRefreshCoordinator(coordinator) {
  _refreshCoordinator = coordinator;
}

function getRefreshLockKey(provider, credentials) {
  const stableId =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name ||
    credentials?.refreshToken?.slice?.(-16) ||
    "default";
  return `${provider}:${stableId}`;
}

export async function withCredentialRefreshLock(provider, credentials, refreshFn) {
  const key = getRefreshLockKey(provider, credentials);
  const existing = refreshLocks.get(key);
  if (existing) return existing;

  const pending = Promise.resolve()
    .then(refreshFn)
    .finally(() => {
      refreshLocks.delete(key);
    });

  refreshLocks.set(key, pending);
  return pending;
}

// Generic cross-process-aware refresh, shared by refreshProviderCredentials
// below and by every executor/handler that refreshes credentials directly
// (default.js, kiro.js, videoCore.js, the models route's OAuth resolver).
// Contract (see src/lib/db/leases.js header): the loser never waits — it
// re-reads state and either adopts what the winner already wrote (returns
// the reloaded row as-is) or defers (returns null) to the next tick/request;
// the winner re-reads the row it is about to mutate and, if it still needs
// refreshing, calls `refreshFn` with the RELOADED credentials (not the ones
// it was called with, since those may already be stale — another instance
// may have rotated the refresh token minutes ago). Without a coordinator
// installed, it just runs `refreshFn(credentials)` under the in-process lock,
// unchanged from before this existed.
//
// `refreshFn`'s return value is passed straight through on the winner path —
// callers that want it merged onto their own credentials shape do that
// merge inside `refreshFn` itself (see refreshProviderCredentials below),
// using the `creds` argument it's called with rather than the outer
// `credentials`, so the merge lands on the same fresher base the provider
// call used.
export async function coordinateRefresh(provider, credentials, log, refreshFn) {
  return withCredentialRefreshLock(provider, credentials, async () => {
    if (!_refreshCoordinator) {
      return refreshFn(credentials);
    }

    let claim;
    try {
      claim = await _refreshCoordinator.claim(provider, credentials);
    } catch (e) {
      // A coordinator is expected to fail open internally (claimLease does);
      // this is a last-resort guard against a broken coordinator implementation.
      log?.warn?.("TOKEN_REFRESH", `refresh coordinator claim failed, failing open: ${e.message}`);
      claim = { won: true, release: async () => {} };
    }

    if (!claim.won) {
      const reloaded = await _refreshCoordinator.reload(provider, credentials);
      return reloaded && !shouldRefreshCredentials(provider, reloaded) ? reloaded : null;
    }

    try {
      const reloaded = await _refreshCoordinator.reload(provider, credentials);
      if (reloaded && !shouldRefreshCredentials(provider, reloaded)) {
        return reloaded;
      }
      return await refreshFn(reloaded || credentials);
    } finally {
      await claim.release();
    }
  });
}

export async function refreshProviderCredentials(provider, credentials, log) {
  if (!credentials) return null;

  return coordinateRefresh(provider, credentials, log, async (creds) => {
    const refreshed = await refreshTokenByProvider(provider, creds, log);
    return mergeRefreshedCredentials(provider, creds, refreshed);
  });
}
