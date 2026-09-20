export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

// Bedrock is always authType "apikey" (src/app/api/providers/route.js sets
// it regardless of authMethod), so the generic authType-driven badge would
// show "API Key" on an IAM/SigV4 connection — read the real credential mode
// from providerSpecificData.authMethod instead, for bedrock only.
export function getAuthBadge(connection, { isOAuthConnection, isCookieConnection } = {}) {
  if (connection?.provider === "bedrock") {
    const isIam = connection.providerSpecificData?.authMethod === "iam";
    return { icon: isIam ? "vpn_key" : "key", label: isIam ? "IAM (SigV4)" : "API key" };
  }
  if (isCookieConnection) return { icon: "cookie", label: "Cookie" };
  if (isOAuthConnection) return { icon: "lock", label: "OAuth" };
  return { icon: "key", label: "API Key" };
}
