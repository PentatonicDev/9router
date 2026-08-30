import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

const NOW = new Date("2026-01-01T12:00:00.000Z");
const RESET_2D = "2026-01-03T10:56:00.000Z";
const RESET_5D = "2026-01-06T10:56:00.000Z";

// Kiro answers 402 with no reset; its usage API reports the exhausted credit window.
const KIRO_EXHAUSTED = {
  quotas: {
    credit: { used: 50, total: 50, remaining: 0, resetAt: RESET_2D },
  },
};

const KIRO_CREDENTIALS = {
  accessToken: "kiro-token",
  providerSpecificData: { authMethod: "builder-id", connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" },
};

describe("exhausted quota reset lookup", () => {
  let getExhaustedQuotaResetMs;
  let deps;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    ({ getExhaustedQuotaResetMs } = await import("../../src/sse/services/quotaReset.js"));
    deps = { getUsageForProvider: vi.fn().mockResolvedValue(KIRO_EXHAUSTED) };
  });

  it("returns the reset of the exhausted Kiro window on 402", async () => {
    const resetMs = await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps);

    expect(resetMs).toBe(new Date(RESET_2D).getTime());
  });

  it("forwards the connection proxy already resolved on the credentials", async () => {
    await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps);

    const [connection, proxyOptions, options] = deps.getUsageForProvider.mock.calls[0];
    expect(connection).toMatchObject({ provider: "kiro", accessToken: "kiro-token" });
    expect(proxyOptions).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy:8080",
      strictProxy: false,
    });
    expect(options).toEqual({ force: true });
  });

  it("waits for the last window to reopen when several are exhausted", async () => {
    deps.getUsageForProvider.mockResolvedValue({
      quotas: {
        credit: { used: 50, total: 50, remaining: 0, resetAt: RESET_2D },
        agentic_request: { used: 10, total: 10, remaining: 0, resetAt: RESET_5D },
      },
    });

    expect(await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps)).toBe(new Date(RESET_5D).getTime());
  });

  it("spends nothing on providers and statuses without a lookup", async () => {
    expect(await getExhaustedQuotaResetMs("kiro", 429, KIRO_CREDENTIALS, deps)).toBeNull();
    expect(await getExhaustedQuotaResetMs("codex", 402, KIRO_CREDENTIALS, deps)).toBeNull();
    expect(deps.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("returns null when the usage API gives nothing usable", async () => {
    deps.getUsageForProvider.mockResolvedValue({ message: "Kiro quota API rejected the current token." });
    expect(await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps)).toBeNull();

    deps.getUsageForProvider.mockResolvedValue({ quotas: { credit: { used: 50, total: 50, remaining: 0 } } });
    expect(await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps)).toBeNull();

    deps.getUsageForProvider.mockResolvedValue({
      quotas: { credit: { used: 50, total: 50, remaining: 0, resetAt: "2025-12-31T00:00:00.000Z" } },
    });
    expect(await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps)).toBeNull();

    deps.getUsageForProvider.mockRejectedValue(new Error("network down"));
    expect(await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps)).toBeNull();
  });

  it("ignores a window that has no allowance at all", async () => {
    deps.getUsageForProvider.mockResolvedValue({
      quotas: {
        credit: { used: 10, total: 50, remaining: 40, resetAt: RESET_2D },
        credit_freetrial: { used: 0, total: 0, remaining: 0, resetAt: RESET_5D },
      },
    });

    expect(await getExhaustedQuotaResetMs("kiro", 402, KIRO_CREDENTIALS, deps)).toBeNull();
  });
});

describe("Kiro monthly limit classification", () => {
  const KIRO_402_BODY = '{"message":"You have reached the limit.","reason":"MONTHLY_REQUEST_COUNT"}';

  it("holds the account for an hour instead of the generic 2min 402 cooldown", async () => {
    const { checkFallbackError } = await import("open-sse/services/accountFallback.js");

    expect(checkFallbackError(402, KIRO_402_BODY)).toEqual({ shouldFallback: true, cooldownMs: 60 * 60 * 1000 });
    // A plain 402 (no monthly-limit reason) keeps the generic cooldown.
    expect(checkFallbackError(402, "Payment required").cooldownMs).toBe(2 * 60 * 1000);
  });
});
