// Skeptic review finding: POST /api/providers required accessKeyId for a
// Bedrock IAM connection but never secretAccessKey, so a direct API call
// (bypassing AddApiKeyModal.js, which enforces both) could persist a
// connection with an empty secret — it would only fail later, at Bedrock
// auth time, instead of at creation with a clear 400.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let POST;
let PUT;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bedrock-iam-"));
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
  ({ POST } = await import("@/app/api/providers/route.js"));
  ({ PUT } = await import("@/app/api/providers/[id]/route.js"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

let connectionSequence = 0;

function iamRequest(providerSpecificData, extra = {}) {
  return new Request("https://9router.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "bedrock",
      name: `Bedrock IAM ${++connectionSequence}`,
      defaultModel: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      providerSpecificData: { authMethod: "iam", region: "us-east-1", ...providerSpecificData },
      ...extra,
    }),
  });
}

describe("POST /api/providers — Bedrock IAM credential pairing", () => {
  it("rejects accessKeyId without secretAccessKey", async () => {
    const res = await POST(iamRequest({ accessKeyId: "AKIA123" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Secret Access Key/);
  });

  it("rejects secretAccessKey without accessKeyId", async () => {
    const res = await POST(iamRequest({ secretAccessKey: "shh" }));
    expect(res.status).toBe(400);
  });

  it("accepts both provided together", async () => {
    const res = await POST(iamRequest({ accessKeyId: "AKIA123", secretAccessKey: "shh" }));
    expect(res.status).toBe(201);
  });

  it("accepts neither provided (falls back to the SDK's default credential chain)", async () => {
    const res = await POST(iamRequest({}));
    expect(res.status).toBe(201);
  });
});

function putRequest(id, patch) {
  return new Request(`https://9router.local/api/providers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// PUT /api/providers/[id] never ran normalizeProviderSpecificData or the bedrock
// IAM pairing rule — an edit could persist a bedrock connection with region/
// authMethod/IAM fields that bypass the same validation POST enforces on create.
describe("PUT /api/providers/[id] — normalization + Bedrock IAM pairing on edit", () => {
  it("rejects an edit that leaves exactly one of accessKeyId/secretAccessKey set", async () => {
    const created = await POST(iamRequest({ accessKeyId: "AKIA123", secretAccessKey: "shh" }));
    const { connection } = await created.json();

    const res = await PUT(
      putRequest(connection.id, { providerSpecificData: { secretAccessKey: "" } }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Secret Access Key/);
  });

  it("a valid edit persists normalized fields (region default, endpoint trimmed, bad inferenceProfilePrefix reset)", async () => {
    const created = await POST(iamRequest({ accessKeyId: "AKIA123", secretAccessKey: "shh" }));
    const { connection } = await created.json();

    const res = await PUT(
      putRequest(connection.id, {
        providerSpecificData: {
          region: "  ",
          endpoint: "  https://vpce-123.bedrock.us-east-1.vpce.amazonaws.com  ",
          inferenceProfilePrefix: "not-a-real-prefix",
        },
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.providerSpecificData.region).toBe("us-east-1");
    expect(body.connection.providerSpecificData.endpoint).toBe("https://vpce-123.bedrock.us-east-1.vpce.amazonaws.com");
    expect(body.connection.providerSpecificData.inferenceProfilePrefix).toBe("");
    // authMethod/accessKeyId carried over from creation, untouched by this edit.
    expect(body.connection.providerSpecificData.authMethod).toBe("iam");
  });

  it("a non-bedrock provider's edit is unchanged (no normalizer branch fires)", async () => {
    const createRes = await POST(new Request("https://9router.local/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        name: "OpenAI key",
        apiKey: "sk-test",
        providerSpecificData: { customFlag: true },
      }),
    }));
    expect(createRes.status).toBe(201);
    const { connection } = await createRes.json();

    const res = await PUT(
      putRequest(connection.id, { providerSpecificData: { customFlag: false, another: "value" } }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.providerSpecificData.customFlag).toBe(false);
    expect(body.connection.providerSpecificData.another).toBe("value");
  });
});
