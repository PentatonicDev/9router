// GET /api/providers/[id]/models — bedrock's customResolver has no live "list
// models" call cheap enough to run on every page load, so it surfaces
// whatever POST /api/providers/bedrock/discover (or /[id]/discover) last
// persisted to providerSpecificData.discoveredModels instead. This is what
// the dashboard's "Available Models" section (page.js) fetches per
// connection once isLlmKindForProvider lets bedrock's discovered
// "model"/"profile" entries through.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let modelsGET;
let createProviderConnection;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bedrock-models-route-"));
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
  ({ GET: modelsGET } = await import("@/app/api/providers/[id]/models/route.js"));
  ({ createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function getModels(id) {
  const req = new Request(`https://x.local/api/providers/${id}/models`);
  const res = await modelsGET(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/providers/[id]/models — bedrock", () => {
  it("returns the persisted discoveredModels items verbatim, including a discovered inference-profile id", async () => {
    const conn = await createProviderConnection({
      provider: "bedrock",
      authType: "apikey",
      name: "Bedrock",
      apiKey: "",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        authMethod: "iam",
        region: "us-east-1",
        accessKeyId: "AKIA",
        secretAccessKey: "shh",
        discoveredModels: {
          at: "2026-09-20T22:53:21.855Z",
          items: [
            { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5", kind: "model", access: "granted" },
            { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "US Claude Sonnet 4.5", kind: "profile", access: "granted", wraps: ["anthropic.claude-sonnet-4-5-20250929-v1:0"] },
          ],
          errors: [],
        },
      },
    });

    const { status, body } = await getModels(conn.id);
    expect(status).toBe(200);
    expect(body.models).toHaveLength(2);
    // The inference-profile id is passed through unchanged — no prefix
    // stripped/added, no id rewriting.
    expect(body.models.map((m) => m.id)).toEqual([
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ]);
    expect(body.models[1].kind).toBe("profile");
  });

  it("warns instead of erroring when nothing has been discovered yet", async () => {
    const conn = await createProviderConnection({
      provider: "bedrock",
      authType: "apikey",
      name: "Bedrock (fresh)",
      apiKey: "",
      isActive: true,
      testStatus: "unknown",
      providerSpecificData: { authMethod: "iam", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "shh" },
    });

    const { status, body } = await getModels(conn.id);
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/Discover models/);
  });
});
