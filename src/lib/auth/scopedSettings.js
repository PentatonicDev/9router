import { getApiKeyOwner } from "@/lib/localDb";
import { isScopeEnabled } from "@/lib/auth/resourceScope";

/**
 * Overlay the calling key owner's own vision-adapter config onto settings.
 *
 * Vision adapters live inside the global settings blob rather than in their own
 * table, so per-user ones are kept in `capacityAdapterByOwner`. Resolving the
 * overlay once, here, means every consumer that already receives `settings`
 * (combo expansion, capability augmentation) sees the right pool unchanged.
 */
export async function resolveScopedSettings(settings, apiKey) {
  if (!isScopeEnabled(settings)) return settings;
  const owner = await getApiKeyOwner(apiKey || null);
  const own = owner ? settings?.capacityAdapterByOwner?.[owner] : null;
  return own ? { ...settings, capacityAdapter: own } : settings;
}

// Headroom keeps per-project stats behind a /p/<name> path prefix. Scoping that
// to the calling API key gives one bucket per key without extra configuration —
// the key NAME, never its value, which would otherwise land in the proxy's URLs.
const PROJECT_SAFE = /[^a-zA-Z0-9._-]+/g;

export function headroomProjectUrl(baseUrl, keyName) {
  const name = String(keyName || "").trim()
    .replace(PROJECT_SAFE, "-")
    .replace(/^[-.]+|[-.]+$/g, "")   // leading dots would read as path traversal
    .slice(0, 60);
  if (!baseUrl || !name) return baseUrl;
  // An explicit /p/<project> in the configured URL is the operator's choice; keep it.
  if (/\/p\/[^/]+\/?$/.test(baseUrl)) return baseUrl;
  return `${String(baseUrl).replace(/\/$/, "")}/p/${encodeURIComponent(name)}`;
}
