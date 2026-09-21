// Management endpoints an administration key (kind: "admin") can call to
// drive the dashboard REST API — combos, providers, keys, settings and
// usage/observability — as its owner. Kept as data so the Profile page's
// reference table and its drift test (tests/unit/management-endpoints.test.js)
// read from one place instead of two copies going stale independently.
//
// `adminOnly` means the route requires the caller's identity to actually be
// an admin (see getRequestIdentity/isAdmin in src/lib/auth/resourceScope.js),
// not just an owned administration key — most routes here are owner-scoped
// and work for any owner's admin key.
export const MANAGEMENT_ENDPOINTS = [
  { method: "GET", path: "/api/combos", purpose: "List model combos", adminOnly: false },
  { method: "POST", path: "/api/combos", purpose: "Create a model combo", adminOnly: false },
  { method: "GET", path: "/api/combos/{id}", purpose: "Get a single combo", adminOnly: false },
  { method: "PUT", path: "/api/combos/{id}", purpose: "Update a combo", adminOnly: false },
  { method: "DELETE", path: "/api/combos/{id}", purpose: "Delete a combo", adminOnly: false },
  { method: "GET", path: "/api/providers", purpose: "List provider connections", adminOnly: false },
  { method: "POST", path: "/api/providers", purpose: "Add a provider connection", adminOnly: false },
  { method: "GET", path: "/api/providers/{id}", purpose: "Get a provider connection", adminOnly: false },
  { method: "PUT", path: "/api/providers/{id}", purpose: "Update a provider connection", adminOnly: false },
  { method: "DELETE", path: "/api/providers/{id}", purpose: "Remove a provider connection", adminOnly: false },
  { method: "POST", path: "/api/providers/{id}/test", purpose: "Test a provider connection", adminOnly: false },
  { method: "POST", path: "/api/providers/{id}/discover", purpose: "Discover available models (Bedrock)", adminOnly: false },
  { method: "GET", path: "/api/keys", purpose: "List API keys", adminOnly: false },
  { method: "POST", path: "/api/keys", purpose: "Create an API key", adminOnly: false },
  { method: "GET", path: "/api/keys/{id}", purpose: "Get a single API key", adminOnly: false },
  { method: "PUT", path: "/api/keys/{id}", purpose: "Update an API key", adminOnly: false },
  { method: "DELETE", path: "/api/keys/{id}", purpose: "Revoke an API key", adminOnly: false },
  { method: "GET", path: "/api/keys/{id}/spend", purpose: "Get spend/budget usage for a key", adminOnly: false },
  { method: "GET", path: "/api/settings", purpose: "Read instance settings", adminOnly: false },
  { method: "PATCH", path: "/api/settings", purpose: "Update instance settings", adminOnly: true },
  { method: "GET", path: "/api/usage/stats", purpose: "Usage and spend statistics", adminOnly: false },
  { method: "GET", path: "/api/usage/request-details", purpose: "Per-request usage detail", adminOnly: false },
  { method: "GET", path: "/v1/admin/request-details", purpose: "List raw request/response traces", adminOnly: false },
  { method: "GET", path: "/v1/admin/request-details/{id}", purpose: "Get one raw request/response trace", adminOnly: false },
  { method: "GET", path: "/v1/models", purpose: "List routable models", adminOnly: false },
];

// What the Profile page's reference table shows: a non-admin's administration
// key can't call an adminOnly route at all, so those rows are dropped rather
// than shown as unreachable; an admin sees everything, including which rows
// are admin-only (the caller renders that as a badge, not a filtered set).
export function visibleEndpointsFor(isAdmin) {
  return isAdmin ? MANAGEMENT_ENDPOINTS : MANAGEMENT_ENDPOINTS.filter((ep) => !ep.adminOnly);
}
