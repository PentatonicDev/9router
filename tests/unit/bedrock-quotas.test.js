// open-sse/services/bedrockQuotas.js — Bedrock quota + today's-usage
// snapshot. @aws-sdk/client-service-quotas and @aws-sdk/client-cloudwatch are
// mocked at the command/client level — no network calls.
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-service-quotas", () => {
  class ListServiceQuotasCommand {
    constructor(input) { this.kind = "ListServiceQuotas"; this.input = input; }
  }
  class ServiceQuotasClient {
    constructor(config) { this.config = config; }
    send(...args) { return sendMock(...args); }
  }
  return { ServiceQuotasClient, ListServiceQuotasCommand };
});

vi.mock("@aws-sdk/client-cloudwatch", () => {
  class ListMetricsCommand {
    constructor(input) { this.kind = "ListMetrics"; this.input = input; }
  }
  class GetMetricDataCommand {
    constructor(input) { this.kind = "GetMetricData"; this.input = input; }
  }
  class CloudWatchClient {
    constructor(config) { this.config = config; }
    send(...args) { return sendMock(...args); }
  }
  return { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand };
});

const { getBedrockQuotaSnapshot, deriveBedrockFamilyLabel, clearBedrockQuotaCache } =
  await import("../../open-sse/services/bedrockQuotas.js");

function iamCredentials(overrides = {}) {
  return {
    providerSpecificData: {
      authMethod: "iam",
      region: "us-east-1",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      ...overrides,
    },
  };
}

const FIELD_BY_METRIC = { InputTokenCount: "inputTokens", OutputTokenCount: "outputTokens", Invocations: "invocations" };

// Routes send() by command kind. `usageByModel` maps modelId -> {inputTokens,
// outputTokens, invocations}; every id present is also reported by ListMetrics
// (discovery), matching how a real account only lists metrics that have data.
function mockAws({ quotaPages = [{ Quotas: [] }], usageByModel = {}, quotasError = null, metricsError = null } = {}) {
  let quotaPageIndex = 0;
  sendMock.mockImplementation(async (command) => {
    if (command.kind === "ListServiceQuotas") {
      if (quotasError) throw quotasError;
      return quotaPages[quotaPageIndex++] || { Quotas: [] };
    }
    if (command.kind === "ListMetrics") {
      if (metricsError) throw metricsError;
      return { Metrics: Object.keys(usageByModel).map((id) => ({ Dimensions: [{ Name: "ModelId", Value: id }] })) };
    }
    if (command.kind === "GetMetricData") {
      if (metricsError) throw metricsError;
      const results = command.input.MetricDataQueries.map((q) => {
        const modelId = q.MetricStat.Metric.Dimensions[0].Value;
        const field = FIELD_BY_METRIC[q.MetricStat.Metric.MetricName];
        return { Id: q.Id, Values: [usageByModel[modelId]?.[field] ?? 0] };
      });
      return { MetricDataResults: results };
    }
    throw new Error(`Unhandled command ${command.kind}`);
  });
}

function awsError(name, message = "denied") {
  const err = new Error(message);
  err.name = name;
  return err;
}

beforeEach(() => {
  sendMock.mockReset();
  clearBedrockQuotaCache();
});

describe("deriveBedrockFamilyLabel", () => {
  it("derives the family label Bedrock quota names use", () => {
    expect(deriveBedrockFamilyLabel("global.anthropic.claude-opus-4-6-v1")).toBe("opus 4.6");
    expect(deriveBedrockFamilyLabel("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("haiku 4.5");
    expect(deriveBedrockFamilyLabel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("sonnet 4.5");
    expect(deriveBedrockFamilyLabel("anthropic.claude-3-5-haiku-20241022-v1:0")).toBe("3.5 haiku");
    expect(deriveBedrockFamilyLabel("anthropic.claude-sonnet-5-v1:0")).toBe("sonnet 5");
    expect(deriveBedrockFamilyLabel("amazon.nova-pro-v1:0")).toBe("nova pro");
  });
});

describe("getBedrockQuotaSnapshot — quota matching", () => {
  it("picks the right quota per scope and never invents a number for an unmatched model", async () => {
    const modelIds = [
      "global.anthropic.claude-opus-4-6-v1",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "anthropic.claude-3-5-haiku-20241022-v1:0",
      "anthropic.claude-sonnet-5-v1:0",
    ];
    mockAws({
      quotaPages: [{
        Quotas: [
          { QuotaName: "Global cross-region model inference tokens per day for Anthropic Claude Opus 4.6", QuotaCode: "g-day", Value: 1000000 },
          { QuotaName: "Global cross-region model inference tokens per minute for Anthropic Claude Opus 4.6 V1", QuotaCode: "g-tpm", Value: 2000 },
          { QuotaName: "Cross-region model inference tokens per minute for Anthropic Claude Haiku 4.5", QuotaCode: "r-tpm", Value: 3000 },
          { QuotaName: "On-demand model inference tokens per minute for Anthropic Claude 3.5 Haiku", QuotaCode: "b-tpm", Value: 4000 },
          // Decoy: same bare/daily scope as "sonnet 5" but a different version — must not match.
          { QuotaName: "Model invocation max tokens per day for Anthropic Claude Sonnet 5.1", QuotaCode: "decoy", Value: 555 },
          { QuotaName: "Cross-Model Account-Level Tokens Per Day", QuotaCode: "acct", Value: 150000000 },
        ],
      }],
      usageByModel: Object.fromEntries(modelIds.map((id) => [id, { inputTokens: 10, outputTokens: 5, invocations: 1 }])),
    });

    const snapshot = await getBedrockQuotaSnapshot(iamCredentials(), { modelIds });
    const byId = Object.fromEntries(snapshot.models.map((m) => [m.id, m]));

    expect(byId["global.anthropic.claude-opus-4-6-v1"].dailyQuota).toBe(1000000);
    expect(byId["global.anthropic.claude-opus-4-6-v1"].tpmQuota).toBe(2000);
    expect(byId["global.anthropic.claude-opus-4-6-v1"].rpmQuota).toBeNull();

    expect(byId["us.anthropic.claude-haiku-4-5-20251001-v1:0"].tpmQuota).toBe(3000);
    expect(byId["us.anthropic.claude-haiku-4-5-20251001-v1:0"].dailyQuota).toBeNull();

    expect(byId["anthropic.claude-3-5-haiku-20241022-v1:0"].tpmQuota).toBe(4000);

    // "sonnet 5" must not match the "Sonnet 5.1" decoy quota.
    expect(byId["anthropic.claude-sonnet-5-v1:0"].dailyQuota).toBeNull();

    expect(snapshot.account.dailyQuota).toBe(150000000);
  });
});

describe("getBedrockQuotaSnapshot — pagination", () => {
  it("joins ListServiceQuotas pages before matching", async () => {
    mockAws({
      quotaPages: [
        { Quotas: [{ QuotaName: "On-demand model inference tokens per minute for Anthropic Claude 3.5 Haiku", QuotaCode: "b-tpm", Value: 111 }], NextToken: "page2" },
        { Quotas: [{ QuotaName: "Cross-Model Account-Level Tokens Per Day", QuotaCode: "acct", Value: 700000000 }] },
      ],
      usageByModel: { "anthropic.claude-3-5-haiku-20241022-v1:0": { inputTokens: 1, outputTokens: 1, invocations: 1 } },
    });

    const snapshot = await getBedrockQuotaSnapshot(iamCredentials(), { modelIds: ["anthropic.claude-3-5-haiku-20241022-v1:0"] });

    expect(snapshot.account.dailyQuota).toBe(700000000);
    expect(snapshot.models[0].tpmQuota).toBe(111);
    expect(sendMock.mock.calls.filter(([c]) => c.kind === "ListServiceQuotas")).toHaveLength(2);
  });
});

describe("getBedrockQuotaSnapshot — usage metrics", () => {
  it("sums input+output into tokensToday per model and account-wide", async () => {
    mockAws({
      usageByModel: {
        "anthropic.claude-3-5-haiku-20241022-v1:0": { inputTokens: 100, outputTokens: 50, invocations: 3 },
        "amazon.nova-pro-v1:0": { inputTokens: 20, outputTokens: 5, invocations: 1 },
      },
    });

    const snapshot = await getBedrockQuotaSnapshot(iamCredentials(), {
      modelIds: ["anthropic.claude-3-5-haiku-20241022-v1:0", "amazon.nova-pro-v1:0"],
    });

    const byId = Object.fromEntries(snapshot.models.map((m) => [m.id, m]));
    expect(byId["anthropic.claude-3-5-haiku-20241022-v1:0"].tokensToday).toBe(150);
    expect(byId["amazon.nova-pro-v1:0"].tokensToday).toBe(25);
    expect(snapshot.account.tokensToday).toBe(175);
  });
});

describe("getBedrockQuotaSnapshot — partial failure", () => {
  it("AccessDenied on quotas still returns metrics, with one error string", async () => {
    mockAws({
      quotasError: awsError("AccessDeniedException"),
      usageByModel: { "anthropic.claude-3-5-haiku-20241022-v1:0": { inputTokens: 10, outputTokens: 10, invocations: 1 } },
    });

    const snapshot = await getBedrockQuotaSnapshot(iamCredentials(), { modelIds: ["anthropic.claude-3-5-haiku-20241022-v1:0"] });

    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toMatch(/servicequotas/i);
    expect(snapshot.models[0].tokensToday).toBe(20);
    expect(snapshot.account.dailyQuota).toBeNull();
  });

  it("api_key credentials skip AWS entirely and report the IAM requirement", async () => {
    const credentials = { apiKey: "bearer-token", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } };
    const snapshot = await getBedrockQuotaSnapshot(credentials, { modelIds: ["anthropic.claude-3-5-haiku-20241022-v1:0"] });

    expect(sendMock).not.toHaveBeenCalled();
    expect(snapshot.models).toEqual([]);
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toMatch(/IAM/);
  });
});

describe("getBedrockQuotaSnapshot — caching", () => {
  it("hits send() once per source across two calls within the TTL", async () => {
    mockAws({
      quotaPages: [{ Quotas: [{ QuotaName: "Cross-Model Account-Level Tokens Per Day", QuotaCode: "acct", Value: 700000000 }] }],
      usageByModel: { "anthropic.claude-3-5-haiku-20241022-v1:0": { inputTokens: 5, outputTokens: 5, invocations: 1 } },
    });

    const now = new Date("2026-09-21T12:00:00.000Z");
    const args = [iamCredentials(), { modelIds: ["anthropic.claude-3-5-haiku-20241022-v1:0"], now }];

    await getBedrockQuotaSnapshot(...args);
    const callsAfterFirst = sendMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await getBedrockQuotaSnapshot(...args);
    expect(sendMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("quota matching prefers the plain model over a qualified variant", () => {
  it("Sonnet 4.5 regional TPM is the 5M quota, not the 1M-context variant", async () => {
    const { getBedrockQuotaSnapshot, clearBedrockQuotaCache } = await import("../../open-sse/services/bedrockQuotas.js");
    clearBedrockQuotaCache();
    const quotas = [
      { QuotaName: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1 1M Context Length", QuotaCode: "L-A", Value: 1_000_000 },
      { QuotaName: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1", QuotaCode: "L-B", Value: 5_000_000 },
    ];
    const { ServiceQuotasClient } = await import("@aws-sdk/client-service-quotas");
    const { CloudWatchClient } = await import("@aws-sdk/client-cloudwatch");
    ServiceQuotasClient.prototype.send = async () => ({ Quotas: quotas });
    CloudWatchClient.prototype.send = async (cmd) => (cmd.constructor.name === "ListMetricsCommand" ? { Metrics: [] } : { MetricDataResults: [] });
    const snap = await getBedrockQuotaSnapshot(
      { providerSpecificData: { authMethod: "iam", region: "us-east-1", accessKeyId: "AKIAPREF", secretAccessKey: "x" } },
      { modelIds: ["us.anthropic.claude-sonnet-4-5-20250929-v1:0"] },
    );
    expect(snap.models[0].tpmQuota).toBe(5_000_000);
  });
});
