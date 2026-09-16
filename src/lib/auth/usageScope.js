import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { getScopeFilter, canSee } from "@/lib/auth/resourceScope";
import { maskApiKey } from "@/lib/db/helpers/maskKey.js";

/**
 * The connection ids and raw key values the caller may see, or null when
 * unrestricted. Usage rows are labelled with account and key names, so the
 * aggregates have to be filtered with the same predicate as the resources.
 */
export async function getUsageVisibility() {
  const filter = await getScopeFilter();
  if (!filter) return null;
  const [connections, keys] = await Promise.all([getProviderConnections(), getApiKeys()]);
  return {
    connectionIds: new Set(connections.filter((c) => canSee(c, filter)).map((c) => c.id)),
    apiKeys: new Set(keys.filter((k) => canSee(k, filter)).map((k) => k.key)),
    // Aggregates key their rows by the masked form, never the raw value.
    maskedApiKeys: new Set(keys.filter((k) => canSee(k, filter)).map((k) => maskApiKey(k.key))),
  };
}

// Rows with no account and no key are local/unattributed traffic: visible to all.
export function canSeeUsageRow(row, visibility) {
  if (!visibility) return true;
  if (row?.connectionId && !visibility.connectionIds.has(row.connectionId)) return false;
  if (row?.apiKey && !visibility.apiKeys.has(row.apiKey)) return false;
  // Read paths hand out the masked form only, so match on that too.
  if (!row?.apiKey && row?.apiKeyMasked && !visibility.maskedApiKeys.has(row.apiKeyMasked)) return false;
  return true;
}

export function scopeUsageStats(stats, visibility) {
  if (!visibility || !stats) return stats;
  const out = { ...stats };
  if (out.byAccount) {
    out.byAccount = Object.fromEntries(
      Object.entries(out.byAccount).filter(([, v]) => !v?.connectionId || visibility.connectionIds.has(v.connectionId))
    );
  }
  if (out.byApiKey) {
    out.byApiKey = Object.fromEntries(
      Object.entries(out.byApiKey).filter(([, v]) => (
        !v?.apiKeyMasked || visibility.maskedApiKeys.has(v.apiKeyMasked)
      ))
    );
  }
  return out;
}
