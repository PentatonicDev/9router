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
 * Missing numbers or `unlimited` count as available.
 */
export function isQuotaExhausted(quota) {
  if (!quota || quota.unlimited === true) return false;

  const remaining = toNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;

  const used = toNumber(quota.used);
  const total = toNumber(quota.total);
  return total !== null && total > 0 && used !== null && used >= total;
}
