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
