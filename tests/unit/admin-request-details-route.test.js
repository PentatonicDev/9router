// Request-details observability API: gated by any active, OWNED API key
// (not just "@admin") AND settings.requireLogin===true &&
// settings.enableObservability===true, then scoped to what that key's owner
// may see (admin owner sees everything). Covers the guard order (key before
// settings), the double opt-in, visibility scoping and the by-id 404-not-403
// leak prevention.
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
let inactiveOwnedKey;
let ownerAKey;
let ownerBKey;

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
  await db.updateSettings({
    requireLogin: true,
    enableObservability: true,
    scopeResourcesByUser: true,
    observabilityBatchSize: 1,
  });

  adminKey = (await db.createApiKey("Admin", "machine-admin", null, "@admin")).key;
  sharedKey = (await db.createApiKey("Shared", "machine-shared")).key;
  ownerAKey = (await db.createApiKey("Owner A", "machine-a", null, "owner-a@example.com")).key;
  ownerBKey = (await db.createApiKey("Owner B", "machine-b", null, "owner-b@example.com")).key;
  const inactive = await db.createApiKey("Inactive owned", "machine-inactive", null, "owner-a@example.com");
  await db.updateApiKey(inactive.id, { isActive: false });
  inactiveOwnedKey = inactive.key;

  await saveDetail({
    id: "req-a1",
    provider: "openai",
    model: "gpt-4",
    status: "ok",
    apiKey: ownerAKey,
    comboName: "combo-a",
    latency: { totalMs: 120 },
    phases: { upstreamMs: 90 },
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    request: { messages: [{ role: "user", content: "secret prompt A" }] },
    providerRequest: { model: "gpt-4" },
    providerResponse: { id: "resp-a1" },
    response: { content: "secret reply A", finish_reason: "stop" },
  });
  await saveDetail({
    id: "req-b1",
    provider: "openai",
    model: "gpt-4",
    status: "ok",
    apiKey: ownerBKey,
    request: { messages: [{ role: "user", content: "secret prompt B" }] },
    response: { content: "secret reply B", finish_reason: "stop" },
  });
  await saveDetail({
    id: "req-unattributed",
    provider: "openai",
    model: "gpt-4",
    status: "ok",
    apiKey: null,
    request: { messages: [{ role: "user", content: "local traffic" }] },
    response: { content: "local reply", finish_reason: "stop" },
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

  it("shared (null-owner) key → 403 active-owned message", async () => {
    // Isolated from the inactive-key case by keeping isActive:true, only owner differs.
    const res = await GET(makeReq("", { "x-api-key": sharedKey }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("active, owned API key required");
  });

  it("owned but inactive key → 403, same message", async () => {
    // Isolated from the shared-key case by keeping owner set, only isActive differs.
    const res = await GET(makeReq("", { "x-api-key": inactiveOwnedKey }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("active, owned API key required");
  });

  it("owned active key + requireLogin:false → 403", async () => {
    await db.updateSettings({ requireLogin: false });
    try {
      const res = await GET(makeReq("", { "x-api-key": ownerAKey }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("observability disabled");
    } finally {
      await db.updateSettings({ requireLogin: true });
    }
  });

  it("owned active key + enableObservability:false → 403", async () => {
    await db.updateSettings({ enableObservability: false });
    try {
      const res = await GET(makeReq("", { "x-api-key": ownerAKey }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("observability disabled");
    } finally {
      await db.updateSettings({ enableObservability: true });
    }
  });

  it("key check runs before the settings check (anti-probing): shared key + observability off still reports the key error", async () => {
    await db.updateSettings({ enableObservability: false });
    try {
      const res = await GET(makeReq("", { "x-api-key": sharedKey }));
      expect(res.status).toBe(403);
      // If the settings check ran first, an invalid caller would see "observability
      // disabled" and learn the setting's state before ever proving a valid key.
      expect((await res.json()).error).toBe("active, owned API key required");
    } finally {
      await db.updateSettings({ enableObservability: true });
    }
  });

  it("owned non-admin key, scopeResourcesByUser on → 200, only own rows", async () => {
    const res = await GET(makeReq("page=1&pageSize=20", { Authorization: `Bearer ${ownerAKey}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.details.map((d) => d.id);
    expect(ids).toContain("req-a1");
    expect(ids).not.toContain("req-b1");
    // Never leak the raw secret — only the masked form is stored on the row.
    expect(JSON.stringify(body)).not.toContain(ownerAKey);
  });

  it("?full=1 → full bodies present on the caller's own (visible) rows, no extra per-field redaction", async () => {
    const res = await GET(makeReq("full=1", { "x-api-key": ownerAKey }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const detail = body.details.find((d) => d.id === "req-a1");
    expect(detail).toBeDefined();
    expect(detail.request).toBeDefined();
    expect(detail.response.content).toBe("secret reply A");
  });

  it("owner B excluded from A's view; unattributed (no apiKey) rows stay visible to everyone", async () => {
    // req-unattributed has apiKey:null — the "local/unattributed traffic" case,
    // which canSeeUsageRow() treats as visible to all, not just the owner of a match.
    const res = await GET(makeReq("page=1&pageSize=20", { "x-api-key": ownerAKey }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.details.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(["req-a1", "req-unattributed"]));
    expect(ids).not.toContain("req-b1");
    expect(body.pagination.totalItems).toBe(2);
  });

  it("pagination reflects the visible set only (not the full unfiltered table)", async () => {
    // pageSize smaller than the visible count matters here: it asserts totalItems/hasNext
    // are computed from the same filtered query as the page, not an unfiltered count.
    const res = await GET(makeReq("page=1&pageSize=1", { "x-api-key": ownerAKey }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.totalItems).toBe(2);
    expect(body.pagination.hasNext).toBe(true);
    expect(body.details).toHaveLength(1);
  });

  it("admin-owned key → 200, sees all rows regardless of scopeResourcesByUser", async () => {
    const res = await GET(makeReq("page=1&pageSize=20", { "x-api-key": adminKey }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.details.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(["req-a1", "req-b1"]));
  });

  it("scopeResourcesByUser:false → any owned key sees everything", async () => {
    await db.updateSettings({ scopeResourcesByUser: false });
    try {
      const res = await GET(makeReq("page=1&pageSize=20", { "x-api-key": ownerAKey }));
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.details.map((d) => d.id);
      expect(ids).toEqual(expect.arrayContaining(["req-a1", "req-b1"]));
    } finally {
      await db.updateSettings({ scopeResourcesByUser: true });
    }
  });

});

describe("GET /api/v1/admin/request-details/[id]", () => {
  it("own id → 200 full stored object", async () => {
    const res = await GET_BY_ID(makeReq("", { "x-api-key": ownerAKey }), { params: Promise.resolve({ id: "req-a1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("req-a1");
    expect(body.request).toBeDefined();
    expect(body.providerResponse).toBeDefined();
  });

  it("id belongs to another owner → 404, not 403 (existence must not leak)", async () => {
    const res = await GET_BY_ID(makeReq("", { "x-api-key": ownerAKey }), { params: Promise.resolve({ id: "req-b1" }) });
    expect(res.status).toBe(404);
  });

  it("unknown id → 404, identical shape to the out-of-scope case", async () => {
    const outOfScope = await GET_BY_ID(makeReq("", { "x-api-key": ownerAKey }), { params: Promise.resolve({ id: "req-b1" }) });
    const unknown = await GET_BY_ID(makeReq("", { "x-api-key": ownerAKey }), { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(await outOfScope.json());
  });

  it("admin key → 200 for a row owned by anyone", async () => {
    const res = await GET_BY_ID(makeReq("", { "x-api-key": adminKey }), { params: Promise.resolve({ id: "req-b1" }) });
    expect(res.status).toBe(200);
  });

  it("no key → 401 (same guard as the collection route)", async () => {
    const res = await GET_BY_ID(makeReq(), { params: Promise.resolve({ id: "req-a1" }) });
    expect(res.status).toBe(401);
  });
});
