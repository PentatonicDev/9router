import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

const { getOidcRuntimeConfig, isOidcAuthMode } = await import("@/lib/auth/oidc.js");

const configured = {
  oidcIssuerUrl: "https://idp.example.com/",
  oidcClientId: "client-1",
  oidcClientSecret: "secret-1",
};

beforeEach(() => vi.clearAllMocks());

describe("OIDC auth mode gate", () => {
  // The dashboard's "OIDC only" button writes authMode "sso"; treating that as
  // not-configured locks the user out (password refused, OIDC refused).
  it("accepts the authMode the dashboard's OIDC-only button writes", async () => {
    mocks.getSettings.mockResolvedValue({ authMode: "sso", ssoType: "oidc", ...configured });
    const config = await getOidcRuntimeConfig();
    expect(config).not.toBeNull();
    expect(config.clientId).toBe("client-1");
  });

  it("accepts oidc and both", async () => {
    for (const authMode of ["oidc", "both"]) {
      mocks.getSettings.mockResolvedValue({ authMode, ssoType: "oidc", ...configured });
      expect(await getOidcRuntimeConfig()).not.toBeNull();
    }
  });

  it("does not hijack a SAML-flavoured sso mode", () => {
    expect(isOidcAuthMode({ authMode: "sso", ssoType: "saml" })).toBe(false);
    expect(isOidcAuthMode({ authMode: "saml", ssoType: "saml" })).toBe(false);
  });

  it("stays null for password mode or incomplete credentials", async () => {
    mocks.getSettings.mockResolvedValue({ authMode: "password", ...configured });
    expect(await getOidcRuntimeConfig()).toBeNull();

    mocks.getSettings.mockResolvedValue({ authMode: "sso", ssoType: "oidc", ...configured, oidcClientSecret: "" });
    expect(await getOidcRuntimeConfig()).toBeNull();
  });
});
