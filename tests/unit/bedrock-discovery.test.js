// open-sse/services/bedrockModels.js — Bedrock model/inference-profile
// discovery. @aws-sdk/client-bedrock is mocked at the command/client level —
// no network calls.
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
const clientConfigs = [];

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient { constructor(config) { this.config = config; } }
  return { BedrockRuntimeClient };
});

vi.mock("@aws-sdk/client-bedrock", () => {
  class ListFoundationModelsCommand { constructor(input) { this.kind = "ListFoundationModels"; this.input = input; } }
  class ListInferenceProfilesCommand { constructor(input) { this.kind = "ListInferenceProfiles"; this.input = input; } }
  class GetFoundationModelAvailabilityCommand { constructor(input) { this.kind = "GetFoundationModelAvailability"; this.input = input; } }
  class BedrockClient {
    constructor(config) { this.config = config; clientConfigs.push(config); }
    send(...args) { return sendMock(...args); }
  }
  return {
    BedrockClient,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
    GetFoundationModelAvailabilityCommand,
  };
});

const { resolveBedrockModels, clearBedrockModelCache } = await import("../../open-sse/services/bedrockModels.js");

function modelSummary(overrides = {}) {
  return {
    modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    modelName: "Claude Sonnet 4.5",
    providerName: "Anthropic",
    outputModalities: ["TEXT"],
    responseStreamingSupported: true,
    inferenceTypesSupported: ["ON_DEMAND"],
    modelLifecycle: { status: "ACTIVE" },
    ...overrides,
  };
}

function profileSummary(overrides = {}) {
  return {
    inferenceProfileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    inferenceProfileName: "US Claude Sonnet 4.5",
    type: "SYSTEM_DEFINED",
    status: "ACTIVE",
    models: [
      { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0" },
      { modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0" },
    ],
    ...overrides,
  };
}

// Routes send() calls by command kind so a test only has to describe the
// happy-path shape it cares about.
function mockSend({ models = [], profiles = [], availability = () => ({ authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" }) } = {}) {
  sendMock.mockImplementation(async (command) => {
    if (command.kind === "ListFoundationModels") return { modelSummaries: models };
    if (command.kind === "ListInferenceProfiles") return { inferenceProfileSummaries: profiles };
    if (command.kind === "GetFoundationModelAvailability") {
      const result = availability(command.input.modelId);
      if (result instanceof Error) throw result;
      return result;
    }
    throw new Error(`Unhandled command ${command.kind}`);
  });
}

function credsFor(providerSpecificData, apiKey = "bearer-token") {
  return { apiKey, providerSpecificData: { authMethod: "api_key", ...providerSpecificData } };
}

beforeEach(() => {
  sendMock.mockReset();
  clientConfigs.length = 0;
  clearBedrockModelCache();
});

describe("resolveBedrockModels — region mode", () => {
  it("lists on-demand text models with granted access", async () => {
    mockSend({ models: [modelSummary()], profiles: [] });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));

    expect(result.mode).toBe("region");
    expect(result.region).toBe("us-east-1");
    expect(result.items).toEqual([
      {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        name: "Claude Sonnet 4.5",
        vendor: "Anthropic",
        kind: "model",
        access: "granted",
        streaming: true,
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("filters out inactive (LEGACY) and non-streaming models", async () => {
    mockSend({
      models: [
        modelSummary({ modelId: "legacy.model", modelLifecycle: { status: "LEGACY" } }),
        modelSummary({ modelId: "no-stream.model", responseStreamingSupported: false }),
        modelSummary({ modelId: "provisioned-only.model", inferenceTypesSupported: ["PROVISIONED"] }),
        modelSummary({ modelId: "kept.model" }),
      ],
    });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));
    expect(result.items.map((i) => i.id)).toEqual(["kept.model"]);
  });

  it("lists inference profiles covering this region, with wrapped model ids and regions", async () => {
    mockSend({ models: [modelSummary()], profiles: [profileSummary()] });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));

    const profile = result.items.find((i) => i.kind === "profile");
    expect(profile).toBeTruthy();
    expect(profile.id).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(profile.wraps).toEqual(["anthropic.claude-sonnet-4-5-20250929-v1:0"]);
    expect(profile.regions.sort()).toEqual(["us-east-1", "us-west-2"]);
    // Inherits the wrapped model's already-resolved access.
    expect(profile.access).toBe("granted");
  });

  it("excludes a profile that does not cover the connection's region", async () => {
    mockSend({
      models: [modelSummary()],
      profiles: [profileSummary({
        inferenceProfileId: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
        models: [{ modelArn: "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0" }],
      })],
    });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));
    expect(result.items.some((i) => i.kind === "profile")).toBe(false);
  });

  it("excludes a profile whose model ARNs don't parse (can't confirm region coverage)", async () => {
    mockSend({
      models: [modelSummary()],
      profiles: [profileSummary({
        inferenceProfileId: "unknown.anthropic.claude-sonnet-4-5-20250929-v1:0",
        models: [{ modelArn: "not-a-valid-arn" }],
      })],
    });
    const result = await resolveBedrockModels(credsFor({ region: "ap-southeast-1" }));
    expect(result.items.some((i) => i.kind === "profile")).toBe(false);
  });

  it("marks (not hides) profiles matching inferenceProfilePrefix, keeping non-matching ones visible", async () => {
    mockSend({
      models: [modelSummary()],
      profiles: [
        profileSummary(), // us.* -> matches "us."
        profileSummary({
          inferenceProfileId: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
          models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0" }],
        }),
      ],
    });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1", inferenceProfilePrefix: "us." }));
    const profiles = result.items.filter((i) => i.kind === "profile");
    expect(profiles).toHaveLength(2);
    expect(profiles.find((p) => p.id.startsWith("us.")).matchesPrefix).toBe(true);
    expect(profiles.find((p) => p.id.startsWith("eu.")).matchesPrefix).toBe(false);
  });

  it("tolerates a denied or unknown availability result without failing discovery", async () => {
    mockSend({
      models: [modelSummary()],
      availability: () => ({ authorizationStatus: "NOT_AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" }),
    });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));
    expect(result.items[0].access).toBe("denied");
    expect(result.errors).toEqual([]);
  });

  // Each of GetFoundationModelAvailability's four independent fields must gate
  // "granted" on its own — a mutant dropping any single check would still pass
  // the plain "all AVAILABLE" happy path above.
  it.each([
    ["entitlementAvailability", { authorizationStatus: "AUTHORIZED", entitlementAvailability: "NOT_AVAILABLE", regionAvailability: "AVAILABLE" }],
    ["regionAvailability", { authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "NOT_AVAILABLE" }],
    ["agreementAvailability", { authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE", agreementAvailability: { status: "PENDING" } }],
  ])("denies access when only %s is unavailable", async (_field, availabilityResult) => {
    mockSend({ models: [modelSummary()], availability: () => availabilityResult });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));
    expect(result.items[0].access).toBe("denied");
  });

  it("grants access when agreementAvailability is present and AVAILABLE", async () => {
    mockSend({
      models: [modelSummary()],
      availability: () => ({ authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE", agreementAvailability: { status: "AVAILABLE" } }),
    });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));
    expect(result.items[0].access).toBe("granted");
  });

  it("maps an AccessDenied (or any) availability error to 'unknown', never failing the whole discovery", async () => {
    mockSend({
      models: [modelSummary()],
      availability: () => Object.assign(new Error("nope"), { name: "AccessDeniedException" }),
    });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));
    expect(result.items[0].access).toBe("unknown");
    expect(result.errors).toEqual([]);
  });
});

describe("resolveBedrockModels — global mode", () => {
  it("lists only global.*-prefixed SYSTEM_DEFINED profiles via the home region", async () => {
    mockSend({
      profiles: [
        profileSummary({ inferenceProfileId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0" }),
        profileSummary({ inferenceProfileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }),
      ],
    });
    const result = await resolveBedrockModels(credsFor({ region: "global", homeRegion: "us-east-1" }));

    expect(result.mode).toBe("global");
    expect(result.region).toBe("us-east-1");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("global.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(result.items[0].kind).toBe("profile");
    // No ListFoundationModels call is ever made in global mode.
    expect(sendMock.mock.calls.some(([cmd]) => cmd.kind === "ListFoundationModels")).toBe(false);
  });

  it("defaults the home region to us-east-1 when unset", async () => {
    mockSend({ profiles: [] });
    const result = await resolveBedrockModels(credsFor({ region: "global" }));
    expect(result.region).toBe("us-east-1");
  });
});

describe("resolveBedrockModels — total failure fallback", () => {
  it("falls back to the seeded registry list with an error, never throwing", async () => {
    sendMock.mockRejectedValue(Object.assign(new Error("boom"), { name: "UnrecognizedClientException" }));
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);
    // Every seeded item is a Bedrock foundation-model id (vendor.family...).
    expect(result.items.every((i) => i.kind === "model" && i.id.includes("."))).toBe(true);
  });

  it("does NOT fall back when foundation models succeed but only the profile call fails", async () => {
    sendMock.mockImplementation(async (command) => {
      if (command.kind === "ListFoundationModels") return { modelSummaries: [modelSummary()] };
      if (command.kind === "GetFoundationModelAvailability") {
        return { authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" };
      }
      if (command.kind === "ListInferenceProfiles") throw Object.assign(new Error("profiles down"), { name: "ThrottlingException" });
      throw new Error("unexpected");
    });
    const result = await resolveBedrockModels(credsFor({ region: "us-east-1" }));

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/profiles down/);
  });
});

describe("resolveBedrockModels — cache + forceRefresh", () => {
  it("serves a second call from cache without hitting AWS again", async () => {
    mockSend({ models: [modelSummary()] });
    const creds = credsFor({ region: "us-east-1" });
    await resolveBedrockModels(creds);
    const callsAfterFirst = sendMock.mock.calls.length;
    await resolveBedrockModels(creds);
    expect(sendMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("forceRefresh bypasses the cache and calls AWS again", async () => {
    mockSend({ models: [modelSummary()] });
    const creds = credsFor({ region: "us-east-1" });
    await resolveBedrockModels(creds);
    const callsAfterFirst = sendMock.mock.calls.length;
    await resolveBedrockModels(creds, { forceRefresh: true });
    expect(sendMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("a different connection's credentials get their own cache entry", async () => {
    mockSend({ models: [modelSummary()] });
    await resolveBedrockModels(credsFor({ region: "us-east-1" }, "token-a"));
    const callsAfterFirst = sendMock.mock.calls.length;
    await resolveBedrockModels(credsFor({ region: "us-east-1" }, "token-b"));
    expect(sendMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("dedupes overlapping in-flight calls for the same credentials into one set of AWS calls", async () => {
    let resolveModels;
    sendMock.mockImplementation((command) => {
      if (command.kind === "ListFoundationModels") {
        return new Promise((resolve) => { resolveModels = () => resolve({ modelSummaries: [modelSummary()] }); });
      }
      if (command.kind === "ListInferenceProfiles") return Promise.resolve({ inferenceProfileSummaries: [] });
      return Promise.resolve({ authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" });
    });
    const creds = credsFor({ region: "us-east-1" });
    const p1 = resolveBedrockModels(creds);
    const p2 = resolveBedrockModels(creds);
    resolveModels();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(sendMock.mock.calls.filter(([cmd]) => cmd.kind === "ListFoundationModels")).toHaveLength(1);
  });
});
