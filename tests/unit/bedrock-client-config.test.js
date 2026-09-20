// open-sse/services/bedrockClient.js — the config shared by the runtime
// executor (open-sse/executors/bedrock.js) and control-plane discovery
// (open-sse/services/bedrockModels.js). Proves both clients resolve the same
// config for the same connection, for both credential modes: api_key sets
// token + authSchemePreference (never credentials), iam sets credentials
// (never token/authSchemePreference), matching the SDK auth-scheme docs
// (aws.auth#sigv4 before smithy.api#httpBearerAuth on both clients).
import { describe, it, expect, vi, beforeEach } from "vitest";

const runtimeConfigs = [];
const controlPlaneConfigs = [];

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient {
    constructor(config) { this.config = config; runtimeConfigs.push(config); }
  }
  return { BedrockRuntimeClient };
});

vi.mock("@aws-sdk/client-bedrock", () => {
  class BedrockClient {
    constructor(config) { this.config = config; controlPlaneConfigs.push(config); }
  }
  return { BedrockClient };
});

const {
  buildBedrockClientConfig,
  createBedrockRuntimeClient,
  createBedrockControlPlaneClient,
} = await import("../../open-sse/services/bedrockClient.js");

const apiKeyCredentials = {
  apiKey: "bearer-secret",
  providerSpecificData: { authMethod: "api_key", region: "us-east-1" },
};

const iamCredentials = {
  providerSpecificData: {
    authMethod: "iam",
    region: "us-west-2",
    accessKeyId: "AKIA123",
    secretAccessKey: "shh",
    sessionToken: "tok",
  },
};

beforeEach(() => {
  runtimeConfigs.length = 0;
  controlPlaneConfigs.length = 0;
});

describe("buildBedrockClientConfig — api_key mode", () => {
  it("sets token + authSchemePreference, never credentials", () => {
    const config = buildBedrockClientConfig(apiKeyCredentials);
    expect(config.token).toEqual({ token: "bearer-secret" });
    expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
    expect(config.credentials).toBeUndefined();
    expect(config.region).toBe("us-east-1");
  });
});

describe("buildBedrockClientConfig — iam mode", () => {
  it("sets credentials, never token/authSchemePreference", () => {
    const config = buildBedrockClientConfig(iamCredentials);
    expect(config.credentials).toEqual({ accessKeyId: "AKIA123", secretAccessKey: "shh", sessionToken: "tok" });
    expect(config.token).toBeUndefined();
    expect(config.authSchemePreference).toBeUndefined();
    expect(config.region).toBe("us-west-2");
  });

  it("falls through to the SDK default provider chain when no accessKeyId is supplied", () => {
    const config = buildBedrockClientConfig({
      providerSpecificData: { authMethod: "iam", region: "us-east-1" },
    });
    expect(config.credentials).toBeUndefined();
    expect(config.token).toBeUndefined();
  });

  it("passes an endpoint override through when set", () => {
    const config = buildBedrockClientConfig({
      providerSpecificData: { authMethod: "iam", region: "us-gov-west-1", endpoint: "https://vpce-123.bedrock.us-gov-west-1.vpce.amazonaws.com" },
    });
    expect(config.endpoint).toBe("https://vpce-123.bedrock.us-gov-west-1.vpce.amazonaws.com");
  });
});

describe("buildBedrockClientConfig — region \"global\" (pseudo-region, not a real AWS SDK region)", () => {
  it("resolves to homeRegion when set", () => {
    const config = buildBedrockClientConfig({
      providerSpecificData: { authMethod: "api_key", region: "global", homeRegion: "eu-west-1" },
    });
    expect(config.region).toBe("eu-west-1");
  });

  it("falls back to us-east-1 when homeRegion is absent", () => {
    const config = buildBedrockClientConfig({
      providerSpecificData: { authMethod: "api_key", region: "global" },
    });
    expect(config.region).toBe("us-east-1");
  });

  it("both the runtime and control-plane client resolve the same region for \"global\" + homeRegion", () => {
    const credentials = { providerSpecificData: { authMethod: "iam", region: "global", homeRegion: "ap-southeast-2" } };
    createBedrockRuntimeClient(credentials);
    createBedrockControlPlaneClient(credentials);

    expect(runtimeConfigs[0].region).toBe("ap-southeast-2");
    expect(controlPlaneConfigs[0].region).toBe("ap-southeast-2");
  });

  it("both clients fall back to us-east-1 together when \"global\" has no homeRegion", () => {
    const credentials = { providerSpecificData: { authMethod: "api_key", region: "global" } };
    createBedrockRuntimeClient(credentials);
    createBedrockControlPlaneClient(credentials);

    expect(runtimeConfigs[0].region).toBe("us-east-1");
    expect(controlPlaneConfigs[0].region).toBe("us-east-1");
  });

  it("a concrete region is unaffected by homeRegion (only the literal \"global\" is resolved)", () => {
    const config = buildBedrockClientConfig({
      providerSpecificData: { authMethod: "api_key", region: "us-west-2", homeRegion: "eu-west-1" },
    });
    expect(config.region).toBe("us-west-2");
  });
});

describe("client-config parity — runtime vs control-plane", () => {
  it("api_key connection: both clients resolve the identical config", () => {
    createBedrockRuntimeClient(apiKeyCredentials);
    createBedrockControlPlaneClient(apiKeyCredentials);

    expect(runtimeConfigs).toHaveLength(1);
    expect(controlPlaneConfigs).toHaveLength(1);
    expect(runtimeConfigs[0]).toEqual(controlPlaneConfigs[0]);
    expect(controlPlaneConfigs[0].token).toEqual({ token: "bearer-secret" });
    expect(controlPlaneConfigs[0].authSchemePreference).toEqual(["httpBearerAuth"]);
    expect(controlPlaneConfigs[0].credentials).toBeUndefined();
  });

  it("iam connection: both clients resolve the identical config", () => {
    createBedrockRuntimeClient(iamCredentials);
    createBedrockControlPlaneClient(iamCredentials);

    expect(runtimeConfigs[0]).toEqual(controlPlaneConfigs[0]);
    expect(controlPlaneConfigs[0].credentials).toEqual({ accessKeyId: "AKIA123", secretAccessKey: "shh", sessionToken: "tok" });
    expect(controlPlaneConfigs[0].token).toBeUndefined();
    expect(controlPlaneConfigs[0].authSchemePreference).toBeUndefined();
  });
});
