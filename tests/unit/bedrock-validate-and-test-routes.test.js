// POST /api/providers/validate and POST /api/providers/[id]/test (via
// testSingleConnection) both need to support bedrock in either authMethod —
// before this, both fell through to their generic "not supported" paths
// (validate: the apiKey-required 400 guard; test: the switch's default case,
// exactly the "Provider test not supported" the dashboard's "Test Connection
// One-by-One" surfaced). @aws-sdk/client-bedrock is mocked — no network calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient { constructor(config) { this.config = config; } }
  return { BedrockRuntimeClient };
});

vi.mock("@aws-sdk/client-bedrock", () => {
  class ListFoundationModelsCommand { constructor(input) { this.input = input; } }
  class ListInferenceProfilesCommand { constructor(input) { this.input = input; } }
  class GetFoundationModelAvailabilityCommand { constructor(input) { this.input = input; } }
  class BedrockClient {
    constructor(config) { this.config = config; }
    send(...args) { return sendMock(...args); }
  }
  return {
    BedrockClient,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
    GetFoundationModelAvailabilityCommand,
  };
});

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let validatePOST;
let createProviderConnection;
let testSingleConnection;

beforeEach(async () => {
  sendMock.mockReset();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bedrock-routes-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
  ({ POST: validatePOST } = await import("@/app/api/providers/validate/route.js"));
  ({ createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js"));
  ({ testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function validateRequest(body) {
  return new Request("https://x.local/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/providers/validate — bedrock", () => {
  it("accepts an iam-mode body with no apiKey (would 400 under the generic guard)", async () => {
    sendMock.mockResolvedValue({});
    const res = await validatePOST(validateRequest({
      provider: "bedrock",
      providerSpecificData: { authMethod: "iam", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "shh" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ valid: true, error: null });
  });

  it("validates api_key mode with the bearer apiKey", async () => {
    sendMock.mockResolvedValue({});
    const res = await validatePOST(validateRequest({
      provider: "bedrock",
      apiKey: "bearer-token",
      providerSpecificData: { authMethod: "api_key", region: "us-east-1" },
    }));
    expect((await res.json()).valid).toBe(true);
  });

  it("reports invalid credentials distinctly from a network failure", async () => {
    const denied = new Error("nope");
    denied.name = "AccessDeniedException";
    sendMock.mockRejectedValueOnce(denied);
    const res1 = await validatePOST(validateRequest({
      provider: "bedrock",
      providerSpecificData: { authMethod: "iam", accessKeyId: "AKIA", secretAccessKey: "bad" },
    }));
    expect(await res1.json()).toEqual({ valid: false, error: "Invalid credentials" });
  });

  it("still 400s a non-bedrock, non-iam request with no apiKey (guard untouched)", async () => {
    const res = await validatePOST(validateRequest({ provider: "openai" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/providers/[id]/test (testSingleConnection) — bedrock", () => {
  it("marks an iam connection active on success and clears any prior error", async () => {
    sendMock.mockResolvedValue({});
    const conn = await createProviderConnection({
      provider: "bedrock",
      authType: "apikey",
      name: "Bedrock IAM",
      apiKey: "",
      isActive: true,
      testStatus: "error",
      lastError: "Provider test not supported",
      providerSpecificData: { authMethod: "iam", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "shh" },
    });

    const result = await testSingleConnection(conn.id);
    expect(result.valid).toBe(true);
    expect(result.error).toBe(null);
  });

  it("marks an api_key connection with invalid credentials as an error, not 'not supported'", async () => {
    const denied = new Error("nope");
    denied.name = "UnrecognizedClientException";
    sendMock.mockRejectedValue(denied);
    const conn = await createProviderConnection({
      provider: "bedrock",
      authType: "apikey",
      name: "Bedrock API key",
      apiKey: "bad-token",
      isActive: true,
      testStatus: "unknown",
      providerSpecificData: { authMethod: "api_key", region: "us-east-1" },
    });

    const result = await testSingleConnection(conn.id);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid credentials");
    expect(result.error).not.toMatch(/not supported/i);
  });
});
