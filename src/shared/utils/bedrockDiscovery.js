// Shared between AddApiKeyModal (preview before saving) and the per-connection
// "Discover" action (ConnectionRow/page.js) so both report identical counts
// for the same discovery result. Accepts either the whole discovery object
// (items + hidden.denied) or a bare items array, for callers that don't have
// the hidden count on hand.
export function summarizeDiscoveryItems(discoveryOrItems) {
  const list = (Array.isArray(discoveryOrItems) ? discoveryOrItems : discoveryOrItems?.items) || [];
  const hiddenDenied = Array.isArray(discoveryOrItems) ? 0 : (discoveryOrItems?.hidden?.denied || 0);
  const modelCount = list.filter((i) => i.kind === "model").length;
  const profileCount = list.filter((i) => i.kind === "profile").length;
  const grantedCount = list.filter((i) => i.access === "granted").length;
  const summary = `${modelCount} model${modelCount === 1 ? "" : "s"}, ${profileCount} profile${profileCount === 1 ? "" : "s"} · ${grantedCount} with access granted`;
  return hiddenDenied > 0 ? `${summary} · ${hiddenDenied} without access hidden` : summary;
}
