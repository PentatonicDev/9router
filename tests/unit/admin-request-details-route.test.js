// Admin-only raw request-details API: gated by an "@admin"-owned API key AND
// settings.enableObservability. Covers the guard order (key before setting)
// and the body-stripping default response.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let GET;
let GET_BY_ID;

let adminKey;
let sharedKey;
let inactiveAdminKey;

async function saveDetail(detail) {
  await db.saveRequestDetail(detail);
  await new Promise((r) => setTimeout(r, 120));
}

function makeReq(query, headers) {
  return new Request(`http://localhost/api/v1/admin/request-details${query ? `?${query}` : ""}`, { headers });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-details-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

  adminKey = (await db.createApiKey("Admin", "machine-admin", null, "@admin")).key;
  sharedKey = (await db.createApiKey("Shared", "machine-shared")).key;
  const inactive = await db.createApiKey("Inactive admin", "machine-inactive", null, "@admin");
  await db.updateApiKey(inactive.id, { isActive: false });
  inactiveAdminKey = inactive.key;

  await saveDetail({
    id: "req-1",
    provider: "openai",
    model: "gpt-4",
    status: "ok",
    apiKey: adminKey,
    comboName: "combo-a",
    latency: { totalMs: 120 },
    phases: { upstreamMs: 90 },
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    request: { messages: [{ role: "user", content: "secret prompt" }] },
    providerRequest: { model: "gpt-4" },
    providerResponse: { id: "resp-1" },
    response: { content: "secret reply", finish_reason: "stop" },
  });

  ({ GET } = await import("@/app/api/v1/admin/request-details/route.js"));
  ({ GET: GET_BY_ID } = await import("@/app/api/v1/admin/request-details/[id]/route.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("GET /api/v1/admin/request-details", () => {
  it("no key → 401", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("shared (non-admin) key → 403", async () => {
    const res = await GET(makeReq("", { "x-api-key": sharedKey }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("admin API key required");
  });

  it("inactive admin key → 403", async () => {
    const res = await GET(makeReq("", { "x-api-key": inactiveAdminKey }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("admin API key required");
  });

  it("admin key + observability off → 403, checked after the key", async () => {
    await db.updateSettings({ enableObservability: false });
    try {
      const res = await GET(makeReq("", { "x-api-key": adminKey }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("observability disabled");
    } finally {
      await db.updateSettings({ enableObservability: true });
    }
  });

  it("admin key + observability on → 200 with metrics, no bodies", async () => {
    const res = await GET(makeReq("page=1&pageSize=20", { Authorization: `Bearer ${adminKey}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 20 });
    const detail = body.details.find((d) => d.id === "req-1");
    expect(detail).toBeDefined();
    expect(detail.latency).toEqual({ totalMs: 120 });
    expect(detail.phases).toEqual({ upstreamMs: 90 });
    expect(detail.comboName).toBe("combo-a");
    expect(detail.response).toEqual({ finish_reason: "stop" });
    expect(detail.request).toBeUndefined();
    expect(detail.providerRequest).toBeUndefined();
    expect(detail.providerResponse).toBeUndefined();
    // Never leak the raw secret — only the masked form is stored on the row.
    expect(JSON.stringify(body)).not.toContain(adminKey);
  });

  it("?full=1 → bodies present", async () => {
    const res = await GET(makeReq("full=1", { "x-api-key": adminKey }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const detail = body.details.find((d) => d.id === "req-1");
    expect(detail.request).toBeDefined();
    expect(detail.response.content).toBe("secret reply");
  });
});

describe("GET /api/v1/admin/request-details/[id]", () => {
  it("known id → 200 full stored object", async () => {
    const res = await GET_BY_ID(makeReq("", { "x-api-key": adminKey }), { params: Promise.resolve({ id: "req-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("req-1");
    expect(body.request).toBeDefined();
    expect(body.providerResponse).toBeDefined();
  });

  it("unknown id → 404", async () => {
    const res = await GET_BY_ID(makeReq("", { "x-api-key": adminKey }), { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(res.status).toBe(404);
  });

  it("no key → 401 (same guard as the collection route)", async () => {
    const res = await GET_BY_ID(makeReq(), { params: Promise.resolve({ id: "req-1" }) });
    expect(res.status).toBe(401);
  });
});
