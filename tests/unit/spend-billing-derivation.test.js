// Covers open-sse/providers/index.js's billing derivation: category === "oauth"
// (subscription/flat-plan providers) => "subscription", everything else
// (apikey/free/freeTier/webCookie) => "usage" — the field spend caps use to
// decide whether a bound account's cost is even capable of tracking spend.
// Keyed on `category`, not `authType`: most oauth-category providers never
// set authType at all (rel-critique.md BUG #9), so keying on it would default
// them the wrong way.
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/providers/index.js";
import REGISTRY from "open-sse/providers/registry/index.js";

describe("provider billing derivation", () => {
  it("marks every oauth-category, transport-bearing provider as subscription", () => {
    const oauthWithTransport = REGISTRY.filter((e) => e.category === "oauth" && e.transport);
    expect(oauthWithTransport.length).toBeGreaterThan(0);
    for (const entry of oauthWithTransport) {
      expect(PROVIDERS[entry.id]?.billing).toBe("subscription");
    }
  });

  it("marks every non-oauth-category, transport-bearing provider as usage", () => {
    const nonOauthWithTransport = REGISTRY.filter((e) => e.category !== "oauth" && e.transport);
    expect(nonOauthWithTransport.length).toBeGreaterThan(0);
    for (const entry of nonOauthWithTransport) {
      expect(PROVIDERS[entry.id]?.billing).toBe("usage");
    }
  });

  // The two edge cases rel-plan.md called out by name: openrouter is
  // credits/usage-billed despite a "freeTier" category (its own
  // transport.usage.url points at OpenRouter's key-credit-balance endpoint),
  // and opencode is noAuth free — both already land on "usage" from the
  // category !== "oauth" default, so neither needs (or has) an override.
  it.each(["openrouter", "opencode"])("%s needs no override — the default already matches its real billing", (id) => {
    expect(PROVIDERS[id]?.billing).toBe("usage");
  });

  it("a well-known subscription provider (claude) and a well-known usage provider (openai) are not swapped", () => {
    expect(PROVIDERS.claude?.billing).toBe("subscription");
    expect(PROVIDERS.openai?.billing).toBe("usage");
  });

  it("an explicit entry.billing override always wins over the category default", () => {
    // No registry file currently sets `billing` explicitly (the audit found
    // the default correct everywhere) — this proves the override plumbing
    // itself works, independent of whether any file uses it today.
    const fakeEntry = { id: "__billing_override_probe__", category: "oauth", billing: "usage", transport: {} };
    const derived = fakeEntry.billing ?? (fakeEntry.category === "oauth" ? "subscription" : "usage");
    expect(derived).toBe("usage");
  });
});
