// Covers the spend-cap filter in src/sse/services/auth.js getProviderCredentials:
// exhausted (over-budget) connections are excluded from selection, and — per
// rel-critique.md BUG #7 — when that filter alone empties the pool it must
// return its own `spendCapExceeded`/402 candidate with reason
// "spend_cap_exceeded", not fall through to the pre-existing
// `noActiveCredentials`/503 branch (which combo.js's allMissing bucket keys
// on the literal reason string "no_active_credentials").
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getApiKeyConnectionBudgets: vi.fn(),
  getExhaustedConnectionIds: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: mocks.getApiKeyAllowedConnectionIds,
  getApiKeyOwner: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/db/repos/spendLedgerRepo.js", () => ({
  getApiKeyConnectionBudgets: mocks.getApiKeyConnectionBudgets,
  getExhaustedConnectionIds: mocks.getExhaustedConnectionIds,
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const conn = (id, extra = {}) => ({
  id,
  provider: "claude",
  authType: "oauth",
  isActive: true,
  priority: 1,
  accessToken: `tok-${id}`,
  providerSpecificData: {},
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({});
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
  mocks.getApiKeyConnectionBudgets.mockResolvedValue({});
  mocks.getExhaustedConnectionIds.mockResolvedValue(new Set());
});

describe("spend-cap filter — account selection", () => {
  it("excludes an over-budget connection and still selects a sibling in the pool", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a"), conn("b")]);
    mocks.getApiKeyConnectionBudgets.mockResolvedValue({ a: { limitUsd: 1, period: "month" } });
    mocks.getExhaustedConnectionIds.mockResolvedValue(new Set(["a"]));

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: "sk-capped" });

    expect(credentials.connectionId).toBe("b");
  });

  it("returns spendCapExceeded/402 with reason spend_cap_exceeded when every bound account is capped", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a"), conn("b")]);
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["a", "b"]);
    mocks.getApiKeyConnectionBudgets.mockResolvedValue({
      a: { limitUsd: 1, period: "month" },
      b: { limitUsd: 1, period: "month" },
    });
    mocks.getExhaustedConnectionIds.mockResolvedValue(new Set(["a", "b"]));

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: "sk-all-capped" });

    expect(credentials.spendCapExceeded).toBe(true);
    expect(credentials.noActiveCredentials).toBeUndefined();
    expect(credentials.candidate.status).toBe(402);
    // The literal string, not just the status: combo.js's allMissing bucket
    // keys on reason === "no_active_credentials" specifically (accountFallback.js
    // excludes 402 from the request-scoped-4xx no-fallback guard too) — a
    // regression that reused that reason string would pass a status-only check.
    expect(credentials.candidate.reason).toBe("spend_cap_exceeded");
    expect(credentials.candidate.reason).not.toBe("no_active_credentials");
  });

  it("does not consult budgets at all for an unbound (no apiKey) request", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a")]);

    await getProviderCredentials("claude", null, "claude-sonnet-5", {});

    expect(mocks.getApiKeyConnectionBudgets).not.toHaveBeenCalled();
  });

  it("leaves the pool untouched when the key has no budgets configured", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a"), conn("b")]);
    mocks.getApiKeyConnectionBudgets.mockResolvedValue({});

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: "sk-free" });

    expect(credentials.connectionId).toBe("a");
    expect(mocks.getExhaustedConnectionIds).not.toHaveBeenCalled();
  });
});
