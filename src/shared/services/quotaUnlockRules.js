// Rules for reconciling a quota lock against the provider's own quota report.
// Kept free of DB/route imports so both the scheduler and the usage route can use them.
import { isQuotaExhausted } from "open-sse/services/usage/quota.js";
import { buildClearModelLocksUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { QUOTA_UNLOCK_CONFIG } from "@/shared/constants/config";

const QUOTA_ERROR_PATTERN = /usage limit|quota|rate.?limit|too many requests|resource_exhausted|reached the limit|monthly_request_count/i;

function isQuotaLock(connection) {
  return Number(connection.errorCode) === 429 || QUOTA_ERROR_PATTERN.test(connection.lastError || "");
}

/**
 * Cheap pre-filter: only long quota locks are worth a usage call. Short backoff
 * locks expire on their own and re-clearing them would just hammer the upstream.
 */
export function needsQuotaCheck(connection, now = Date.now()) {
  if (connection.isActive === false) return false;
  const lockedUntil = getEarliestModelLockUntil(connection);
  if (!lockedUntil) return false;
  if (new Date(lockedUntil).getTime() - now < QUOTA_UNLOCK_CONFIG.minLockRemainingMs) return false;
  return isQuotaLock(connection);
}

/**
 * Build the update that clears the locks, or null when the lock must stand.
 * A provider that reports no quota at all keeps its lock — silence is not consent.
 */
export function buildQuotaUnlockUpdate(connection, usage, now = Date.now()) {
  if (!needsQuotaCheck(connection, now)) return null;

  const quotas = usage?.quotas;
  if (!quotas || Object.keys(quotas).length === 0) return null;
  if (Object.values(quotas).some(isQuotaExhausted)) return null;

  return {
    ...buildClearModelLocksUpdate(connection),
    testStatus: "active",
    lastError: null,
    errorCode: null,
    lastErrorAt: null,
    backoffLevel: 0,
    updatedAt: new Date(now).toISOString(),
  };
}
