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
      plan: "Amazon Bedrock credits",
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
      expect(usage).toEqual({ message: "Set Credits (USD) on this connection to track spend against it." });
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
