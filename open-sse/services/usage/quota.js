/**
 * Quota window predicates. Dependency-free on purpose: usage/shared.js pulls the
 * whole provider registry in, and these are read by app-side schedulers.
 */

function toNumber(value) {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/**
 * A quota window is exhausted only when the provider reports nothing left.
 * Missing numbers or `unlimited` count as available, and so does a window with
 * no allowance at all (Kiro reports an expired free trial as 0/0) — that is an
 * absent window, not an exhausted one, and reading it as exhausted would pin
 * the account down forever.
 */
export function isQuotaExhausted(quota) {
  if (!quota || quota.unlimited === true) return false;

  const total = toNumber(quota.total);
  if (total !== null && total <= 0) return false;

  const remaining = toNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;

  const used = toNumber(quota.used);
  return total !== null && used !== null && used >= total;
}
