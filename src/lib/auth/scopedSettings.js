import { getApiKeyOwner } from "@/lib/localDb";
import { isScopeEnabled } from "@/lib/auth/resourceScope";

// Token-saver keys a user may override. Whatever they leave unset keeps the
// global value, which is the admin's — so the default stays one place to change.
export const TOKEN_SAVER_KEYS = [
  "rtkEnabled",
  "headroomEnabled",
  "headroomCompressUserMessages",
  "cavemanEnabled", "cavemanLevel",
  "ponytailEnabled", "ponytailLevel",
  "pxpipeEnabled",
];

/**
 * Resolve the effective token-saver settings for an owner: their own overrides
 * on top of the global ones. Returns the merged view plus which keys came from
 * the override, so the dashboard can show what is inherited rather than leaving
 * the user guessing whose setting is in force.
 */
export function resolveTokenSaverFor(settings, owner) {
  const overrides = (owner && settings?.tokenSaverByOwner?.[owner]) || {};
  const effective = {};
  const overridden = [];
  for (const key of TOKEN_SAVER_KEYS) {
    if (Object.hasOwn(overrides, key)) {
      effective[key] = overrides[key];
      overridden.push(key);
    } else {
      effective[key] = settings?.[key];
    }
  }
  return { effective, overridden, usingDefaults: overridden.length === 0 };
}

/**
 * Overlay the calling key owner's own config onto settings.
 *
 * Vision adapters and token-saver flags live inside the global settings blob
 * rather than in their own tables, so per-user ones are kept in
 * `capacityAdapterByOwner` / `tokenSaverByOwner`. Resolving the overlay once,
 * here, means every consumer that already receives `settings` (combo expansion,
 * capability augmentation, the token savers) sees the right values unchanged.
 */
export async function resolveScopedSettings(settings, apiKey) {
  if (!isScopeEnabled(settings)) return settings;
  const owner = await getApiKeyOwner(apiKey || null);
  if (!owner) return settings;

  const merged = { ...settings };
  const adapter = settings?.capacityAdapterByOwner?.[owner];
  if (adapter) merged.capacityAdapter = adapter;

  const { effective, overridden } = resolveTokenSaverFor(settings, owner);
  for (const key of overridden) merged[key] = effective[key];

  return merged;
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
