// Shared between AddApiKeyModal (preview before saving) and the per-connection
// "Discover" action (ConnectionRow/page.js) so both report identical counts
// for the same discovery.items shape ({ kind: "model"|"profile", access }).
export function summarizeDiscoveryItems(items) {
  const list = items || [];
  const modelCount = list.filter((i) => i.kind === "model").length;
  const profileCount = list.filter((i) => i.kind === "profile").length;
  const grantedCount = list.filter((i) => i.access === "granted").length;
  return `${modelCount} model${modelCount === 1 ? "" : "s"}, ${profileCount} profile${profileCount === 1 ? "" : "s"} · ${grantedCount} with access granted`;
}
