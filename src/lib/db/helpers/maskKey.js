// Usage records store the raw key for filtering, but every read path must
// hand out a masked form — the dashboard is not a place to surface live keys.
//
// Keys issued by one instance share a machineId-derived prefix, so masking by
// prefix alone collapses every key of that instance into one label (and made
// usage rows attribute traffic to the wrong key). Keep a tail slice too: it is
// the part that actually distinguishes them.
export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  if (key.length <= 14) return key.slice(0, 8) + "***";
  return key.slice(0, 8) + "***" + key.slice(-4);
}
