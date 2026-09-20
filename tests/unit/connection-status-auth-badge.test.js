// ConnectionRow.js shows the connection's auth-method badge — bedrock is
// always authType "apikey" even in IAM mode (route.js sets authType from the
// isWebCookieProvider check alone), so the generic authType-driven label
// would show "API Key" on a SigV4 connection. getAuthBadge reads the real
// mode from providerSpecificData.authMethod for bedrock specifically.
import { describe, it, expect } from "vitest";
import { getAuthBadge } from "@/shared/utils/connectionStatus";

describe("getAuthBadge", () => {
  it("labels a bedrock iam connection distinctly from the generic API-key badge", () => {
    const badge = getAuthBadge({ provider: "bedrock", providerSpecificData: { authMethod: "iam" } }, {});
    expect(badge).toEqual({ icon: "vpn_key", label: "IAM (SigV4)" });
  });

  it("labels a bedrock api_key connection as 'API key' (bedrock branch, not the generic one)", () => {
    const badge = getAuthBadge({ provider: "bedrock", providerSpecificData: { authMethod: "api_key" } }, {});
    expect(badge).toEqual({ icon: "key", label: "API key" });
  });

  it("leaves every non-bedrock provider on the generic authType label", () => {
    expect(getAuthBadge({ provider: "openai" }, { isOAuthConnection: false, isCookieConnection: false }))
      .toEqual({ icon: "key", label: "API Key" });
    expect(getAuthBadge({ provider: "codex" }, { isOAuthConnection: true, isCookieConnection: false }))
      .toEqual({ icon: "lock", label: "OAuth" });
    expect(getAuthBadge({ provider: "grok-web" }, { isOAuthConnection: false, isCookieConnection: true }))
      .toEqual({ icon: "cookie", label: "Cookie" });
  });
});
