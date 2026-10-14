// AWS-signed connections are authType "apikey" whatever their credential mode, so
// getAuthBadge reads the mode from providerSpecificData (a profile means SSO/config).
import { describe, it, expect } from "vitest";
import { getAuthBadge } from "@/shared/utils/connectionStatus";

describe("getAuthBadge", () => {
  it("labels a bedrock profile (SSO) connection distinctly from static keys", () => {
    expect(getAuthBadge({ provider: "bedrock", providerSpecificData: { profile: "dev" } }, {}))
      .toEqual({ icon: "vpn_key", label: "AWS profile" });
  });

  it("labels a bedrock static-key connection as AWS keys", () => {
    expect(getAuthBadge({ provider: "bedrock", providerSpecificData: { accessKeyId: "AKIA" } }, {}))
      .toEqual({ icon: "key", label: "AWS keys" });
  });

  it("leaves every non-AWS provider on the generic authType label", () => {
    expect(getAuthBadge({ provider: "openai" }, { isOAuthConnection: false, isCookieConnection: false }))
      .toEqual({ icon: "key", label: "API Key" });
    expect(getAuthBadge({ provider: "codex" }, { isOAuthConnection: true, isCookieConnection: false }))
      .toEqual({ icon: "lock", label: "OAuth" });
    expect(getAuthBadge({ provider: "grok-web" }, { isOAuthConnection: false, isCookieConnection: true }))
      .toEqual({ icon: "cookie", label: "Cookie" });
  });
});
