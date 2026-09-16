// Usage records store the raw key for filtering, but every read path must
// hand out a masked form — the dashboard is not a place to surface live keys.
export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}
