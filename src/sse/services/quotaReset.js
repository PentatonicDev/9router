// Some providers reject an exhausted account without saying when it reopens —
// Kiro answers 402 {"message":"You have reached the limit.","reason":"MONTHLY_REQUEST_COUNT"}.
// Their usage API does know, so ask it and lock the account until the real reset
// instead of retrying it every couple of minutes for days.
import { getUsageForProvider } from "open-sse/services/usage.js";
import { isQuotaExhausted } from "open-sse/services/usage/quota.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

// provider → statuses whose error body carries no reset of its own.
const QUOTA_RESET_LOOKUP = {
  kiro: [402],
};

/**
 * Latest reset among the exhausted quota windows, or null when the usage API
 * says nothing useful. The latest wins: the account is only usable again once
 * every exhausted window has reopened.
 */
export async function getExhaustedQuotaResetMs(provider, status, credentials, deps = { getUsageForProvider }) {
  const providerId = resolveProviderId(provider);
  if (!QUOTA_RESET_LOOKUP[providerId]?.includes(Number(status))) return null;

  try {
    // providerSpecificData already carries the resolved proxy (see getProviderCredentials).
    const psd = credentials?.providerSpecificData || {};
    const usage = await deps.getUsageForProvider({
      provider: providerId,
      accessToken: credentials?.accessToken,
      apiKey: credentials?.apiKey,
      providerSpecificData: psd,
      projectId: credentials?.projectId,
    }, {
      connectionProxyEnabled: psd.connectionProxyEnabled === true,
      connectionProxyUrl: psd.connectionProxyUrl || "",
      connectionNoProxy: psd.connectionNoProxy || "",
      vercelRelayUrl: psd.vercelRelayUrl || "",
      strictProxy: false,
    }, { force: true });

    const now = Date.now();
    let latest = null;
    for (const quota of Object.values(usage?.quotas || {})) {
      if (!isQuotaExhausted(quota) || !quota.resetAt) continue;
      const ms = new Date(quota.resetAt).getTime();
      if (!Number.isFinite(ms) || ms <= now) continue;
      if (!latest || ms > latest) latest = ms;
    }
    return latest;
  } catch {
    return null;
  }
}
