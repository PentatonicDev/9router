// Bedrock has no native quota API, so the "Credits (USD)" tracker row is
// synthesized locally: total = the connection's providerSpecificData.creditsUsd
// ceiling, used = lifetime spend from usageHistory. Covers the pure builder,
// the normalizer that validates/clears creditsUsd, and (best-effort) that the
// client route's eligibility filter only lists a bedrock connection once
// creditsUsd is set.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildBedrockCreditsUsage } from "@/lib/usage/bedrockCredits.js";
import { normalizeProviderSpecificData } from "@/lib/providerNormalization.js";

const clientRouteMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getApiKeys: vi.fn(),
  getSettings: vi.fn(),
  backfillCodexEmails: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: clientRouteMocks.getProviderConnections,
  getApiKeys: clientRouteMocks.getApiKeys,
  getSettings: clientRouteMocks.getSettings,
}));
vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: clientRouteMocks.backfillCodexEmails }));

describe("buildBedrockCreditsUsage", () => {
  it("returns a Credits (USD) quota row when creditsUsd is set, rounding spend to 4 decimals", () => {
    const usage = buildBedrockCreditsUsage(100, 12.34564);
    expect(usage).toEqual({
      plan: "Amazon Bedrock",
      quotas: {
        "Credits (USD)": { used: 12.3456, total: 100, resetAt: null, unlimited: false },
      },
    });
  });

  it("rounds spend down when the fifth decimal is below 5", () => {
    const usage = buildBedrockCreditsUsage(100, 12.34444);
    expect(usage.quotas["Credits (USD)"].used).toBe(12.3444);
  });

  it("treats no spend as zero used", () => {
    const usage = buildBedrockCreditsUsage(50, 0);
    expect(usage.quotas["Credits (USD)"].used).toBe(0);
  });

  for (const bad of [undefined, null, 0, -3, NaN, "abc"]) {
    it(`returns a message instead of quotas when creditsUsd is ${bad}`, () => {
      const usage = buildBedrockCreditsUsage(bad, 5);
      expect(usage).toEqual({ message: "Set Credits (USD) on this connection, or use IAM credentials so Bedrock quotas can be read." });
    });
  }
});

describe("normalizeProviderSpecificData — bedrock creditsUsd", () => {
  it("keeps a numeric string, coerced to a number", () => {
    const next = normalizeProviderSpecificData("bedrock", {}, { authMethod: "api_key", creditsUsd: "1000.5" });
    expect(next.creditsUsd).toBe(1000.5);
  });

  it("keeps a plain positive number", () => {
    const next = normalizeProviderSpecificData("bedrock", {}, { authMethod: "api_key", creditsUsd: 1000 });
    expect(next.creditsUsd).toBe(1000);
  });

  for (const bad of [0, -3, "abc", null]) {
    it(`drops creditsUsd when it is ${JSON.stringify(bad)}`, () => {
      const next = normalizeProviderSpecificData("bedrock", {}, { authMethod: "api_key", creditsUsd: bad });
      expect(next && "creditsUsd" in next).toBe(false);
    });
  }

  it("still normalizes the existing bedrock fields alongside creditsUsd", () => {
    const next = normalizeProviderSpecificData("bedrock", {}, {
      authMethod: "iam",
      region: "  ",
      inferenceProfilePrefix: "bogus",
      accessKeyId: " AKIA123 ",
      secretAccessKey: " shh ",
      creditsUsd: "250",
    });
    expect(next.authMethod).toBe("iam");
    expect(next.region).toBe("us-east-1");
    expect(next.inferenceProfilePrefix).toBe("");
    expect(next.accessKeyId).toBe("AKIA123");
    expect(next.secretAccessKey).toBe("shh");
    expect(next.creditsUsd).toBe(250);
  });

  it("a client can clear creditsUsd on a PUT-style merge by sending null", () => {
    // Simulates [id]/route.js's merge-then-normalize: existing has creditsUsd,
    // the incoming patch sets it to null to clear it.
    const merged = { authMethod: "api_key", region: "us-east-1", creditsUsd: null };
    const next = normalizeProviderSpecificData("bedrock", {}, merged);
    expect("creditsUsd" in next).toBe(false);
  });
});

describe("GET /api/providers/client — bedrock eligibility depends on creditsUsd", () => {
  const mocks = clientRouteMocks;

  let GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([]);
    mocks.getSettings.mockResolvedValue({});
    mocks.backfillCodexEmails.mockResolvedValue();
    ({ GET } = await import("@/app/api/providers/client/route.js"));
  });

  const bedrockConn = (id, providerSpecificData) => ({
    id, provider: "bedrock", authType: "apikey", isActive: true, priority: 1,
    providerSpecificData,
  });

  it("lists a bedrock connection with creditsUsd set, and omits one without it", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      bedrockConn("with-credits", { authMethod: "api_key", creditsUsd: 100 }),
      bedrockConn("without-credits", { authMethod: "api_key" }),
    ]);

    const res = await GET(new Request("https://router.test/api/providers/client"));
    const body = await res.json();
    const ids = body.connections.map((c) => c.id);

    expect(ids).toContain("with-credits");
    expect(ids).not.toContain("without-credits");
  });
});

describe("buildBedrockCreditsUsage with a quota snapshot", () => {
  const now = Date.UTC(2026, 8, 21, 4, 0, 0);
  const snapshot = {
    account: { tokensToday: 26_648, dailyQuota: 150_000_000 },
    models: [
      { id: "global.anthropic.claude-haiku-4-5-20251001-v1:0", tokensToday: 25_004, dailyQuota: null },
      { id: "anthropic.claude-opus-4-5-20251101-v1:0", tokensToday: 1_644, dailyQuota: 6_750_000 },
      { id: "amazon.nova-micro-v1:0", tokensToday: 0, dailyQuota: null },
    ],
    errors: [],
  };

  it("adds the account row, a bounded row for a published quota and an unlimited-flagged row otherwise", () => {
    const usage = buildBedrockCreditsUsage(null, 0, snapshot, now);
    expect(usage.plan).toBe("Amazon Bedrock");
    expect(usage.quotas["Tokens today · all models"]).toEqual({ used: 26_648, total: 150_000_000, resetAt: "2026-09-22T00:00:00.000Z", unlimited: false });
    expect(usage.quotas["Tokens today · claude-opus-4-5-20251101"]).toMatchObject({ used: 1_644, total: 6_750_000, unlimited: false });
    expect(usage.quotas["Tokens today · global · claude-haiku-4-5-20251001 (daily limit unpublished)"]).toMatchObject({ used: 25_004, unlimited: true });
    expect(Object.keys(usage.quotas).some((k) => k.includes("nova"))).toBe(false);
  });

  it("keeps the credits row first alongside the quota rows and surfaces snapshot errors as a warning", () => {
    const usage = buildBedrockCreditsUsage(250, 0.5, { ...snapshot, errors: ["quotas: AccessDenied"] }, now);
    expect(Object.keys(usage.quotas)[0]).toBe("Credits (USD)");
    expect(usage.warning).toContain("AccessDenied");
  });

  it("falls back to a message when neither credits nor quotas produce a row", () => {
    const usage = buildBedrockCreditsUsage(null, 0, { account: {}, models: [], errors: ["needs IAM"] }, now);
    expect(usage.message).toContain("needs IAM");
  });
});
