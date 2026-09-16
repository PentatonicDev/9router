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
