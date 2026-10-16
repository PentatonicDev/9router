import { AI_PROVIDERS } from "@/shared/constants/providers";

export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

// AWS-signed connections are authType "apikey" whatever their credential mode;
// a `profile` means AWS SSO/config credentials, otherwise static access keys.
export function getAuthBadge(connection, { isOAuthConnection, isCookieConnection } = {}) {
  if (AI_PROVIDERS[connection?.provider]?.credentialForm === "aws") {
    return connection.providerSpecificData?.profile
      ? { icon: "vpn_key", label: "AWS profile" }
      : { icon: "key", label: "AWS keys" };
  }
  if (isCookieConnection) return { icon: "cookie", label: "Cookie" };
  if (isOAuthConnection) return { icon: "lock", label: "OAuth" };
  return { icon: "key", label: "API Key" };
}

/**
 * Identify providers that have connections configured, but ALL of them are deactivated (isActive === false).
 * Providers with 0 connections (e.g. keyless local nodes) are NOT considered deactivated.
 * @param {Array<{provider: string, isActive?: boolean}>} connections
 * @returns {Set<string>} Set of deactivated provider IDs
 */
export function getDeactivatedProviderIds(connections) {
  const byProvider = {};
  for (const c of connections || []) {
    if (!c?.provider) continue;
    if (!byProvider[c.provider]) byProvider[c.provider] = { total: 0, active: 0 };
    byProvider[c.provider].total += 1;
    if (c.isActive !== false) byProvider[c.provider].active += 1;
  }
  const deactivated = new Set();
  for (const [provider, stats] of Object.entries(byProvider)) {
    if (stats.total > 0 && stats.active === 0) {
      deactivated.add(provider);
    }
  }
  return deactivated;
}
