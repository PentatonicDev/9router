// open-sse/services/bedrockModels.js — probeBedrockCredential, the shared
// cheap control-plane check used by both /api/providers/validate and
// /api/providers/[id]/test (testUtils.js) to validate a Bedrock credential in
// either authMethod. @aws-sdk/client-bedrock is mocked — no network calls.
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

const { probeBedrockCredential } = await import("../../open-sse/services/bedrockModels.js");

beforeEach(() => {
  sendMock.mockReset();
  clientConfigs.length = 0;
});

describe("probeBedrockCredential", () => {
  it("is valid when the control-plane call succeeds", async () => {
    sendMock.mockResolvedValue({ modelSummaries: [] });
    const result = await probeBedrockCredential({
      providerSpecificData: { authMethod: "iam", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "shh" },
    });
    expect(result).toEqual({ valid: true, error: null });
    // Sends exactly one control-plane call — cheap, not a full discovery.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("builds a sigv4 client for iam mode", async () => {
    sendMock.mockResolvedValue({});
    await probeBedrockCredential({
      providerSpecificData: { authMethod: "iam", region: "eu-west-1", accessKeyId: "AKIA", secretAccessKey: "shh" },
    });
    expect(clientConfigs[0].credentials).toEqual({ accessKeyId: "AKIA", secretAccessKey: "shh", sessionToken: undefined });
    expect(clientConfigs[0].token).toBeUndefined();
  });

  it("builds a bearer-token client for api_key mode", async () => {
    sendMock.mockResolvedValue({});
    await probeBedrockCredential({ apiKey: "bearer-token", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } });
    expect(clientConfigs[0].token).toEqual({ token: "bearer-token" });
    expect(clientConfigs[0].credentials).toBeUndefined();
  });

  it.each(["AccessDeniedException", "UnrecognizedClientException", "InvalidSignatureException", "ExpiredTokenException"])(
    "maps %s to 'Invalid credentials'",
    async (name) => {
      const err = new Error("boom");
      err.name = name;
      sendMock.mockRejectedValue(err);
      const result = await probeBedrockCredential({ providerSpecificData: { authMethod: "api_key" }, apiKey: "x" });
      expect(result).toEqual({ valid: false, error: "Invalid credentials" });
    }
  );

  it("surfaces a network/other error's own message", async () => {
    sendMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND bedrock.invalid-region.amazonaws.com"));
    const result = await probeBedrockCredential({ providerSpecificData: { authMethod: "api_key" }, apiKey: "x" });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("getaddrinfo ENOTFOUND bedrock.invalid-region.amazonaws.com");
  });
});
