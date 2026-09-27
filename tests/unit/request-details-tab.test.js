// Backend logic behind /dashboard/usage?tab=details.
// Covers crash-risk edge cases in getRequestDetails() used by
// /api/usage/request-details and /api/usage/providers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const authContext = vi.hoisted(() => ({ token: null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => authContext.token ? { value: authContext.token } : undefined }),
  headers: async () => ({ get: () => null }),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

async function saveDetail(detail) {
  await db.saveRequestDetail(detail);
  await new Promise((r) => setTimeout(r, 120));
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-details-tab-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("request details — tab crash-risk cases", () => {
  it("corrupt data column → parseJson fallback {}, no throw", async () => {
    // Inject a row with invalid JSON directly, bypassing save path
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["corrupt-1", new Date().toISOString(), "openai", "gpt-4", null, "ok", "{not-valid-json"]
    );

    const res = await db.getRequestDetails({ provider: "openai" });
    expect(Array.isArray(res.details)).toBe(true);
    const corrupt = res.details.find((d) => Object.keys(d).length === 0);
    expect(corrupt).toEqual({});
  });

  it("pagination beyond last page → empty details, valid meta", async () => {
    const res = await db.getRequestDetails({ page: 9999, pageSize: 20 });
    expect(res.details).toEqual([]);
    expect(res.pagination.page).toBe(9999);
    expect(res.pagination.hasNext).toBe(false);
    expect(res.pagination.totalItems).toBeGreaterThanOrEqual(0);
  });

  it("invalid startDate → Invalid Date ISO throws inside getRequestDetails is caught upstream", async () => {
    // new Date("bad").toISOString() throws RangeError; verify it surfaces
    // so the API route's try/catch returns 500 rather than silent corruption.
    await expect(db.getRequestDetails({ startDate: "not-a-date" })).rejects.toThrow();
  });

  it("valid date filter range → no throw", async () => {
    const res = await db.getRequestDetails({
      startDate: "2020-01-01T00:00:00",
      endDate: "2999-01-01T00:00:00",
    });
    expect(Array.isArray(res.details)).toBe(true);
  });

  it("large pageSize (providers route uses 9999) → returns all, no crash", async () => {
    await saveDetail({
      id: "big-1", provider: "anthropic", model: "claude-3",
      status: "ok", tokens: { input_tokens: 5 },
      request: { method: "POST" }, response: { content: "hi" },
    });

    const res = await db.getRequestDetails({ pageSize: 9999 });
    expect(res.details.length).toBeGreaterThanOrEqual(1);
    expect(res.pagination.pageSize).toBe(9999);
  });

  it("oversized field → stored truncated + reparseable (no circular)", async () => {
    const huge = "x".repeat(20 * 1024);
    await saveDetail({
      id: "trunc-1", provider: "openai", model: "gpt-4",
      status: "ok", tokens: {},
      request: { blob: huge }, response: { content: "ok" },
    });

    const got = await db.getRequestDetailById("trunc-1");
    expect(got).toBeDefined();
    // Truncated field is a plain object safe for JSON.stringify in the drawer
    expect(() => JSON.stringify(got)).not.toThrow();
    expect(got.request._truncated).toBe(true);
  });

  it("keeps readable streamed text and tool metadata when response exceeds storage cap", async () => {
    await saveDetail({ id: "stream-large", provider: "anthropic", model: "claude", status: "ok",
      response: { content: "x".repeat(12 * 1024), thinking: "reason", toolCalls: 2 } });
    const got = await db.getRequestDetailById("stream-large");
    expect(got.response.content).toMatch(/^x{1000}/);
    expect(got.response.content.length).toBeLessThan(12 * 1024);
    expect(got.response).toMatchObject({ thinking: "reason", toolCalls: 2, truncated: true });
  });

  it("missing tokens/timestamp on row → getInputTokens-style access safe", async () => {
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["sparse-1", new Date().toISOString(), "openai", null, null, null, JSON.stringify({ id: "sparse-1" })]
    );
    const got = await db.getRequestDetailById("sparse-1");
    expect(got.tokens).toBeUndefined();
    // Drawer reads tokens?.prompt_tokens — optional chaining tolerates undefined
    expect(got.tokens?.prompt_tokens || 0).toBe(0);
  });
});

// Mirror of RequestDetailsTab token helpers (component is "use client",
// helpers are not exported). Keep in sync with the component.
function getCachedTokens(tokens) {
  return tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
}
function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}
function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

describe("session detail persistence", () => {
  const sessionId = "a".repeat(64);
  const otherSessionId = "b".repeat(64);

  it("creates the session column and index on a fresh SQLite database", () => {
    expect(adapter.all("PRAGMA table_info(requestDetails)").map((c) => c.name)).toContain("sessionId");
    expect(adapter.all("PRAGMA index_list(requestDetails)").map((i) => i.name)).toContain("idx_rd_session");
  });

  it("persists and paginates a session across providers and keys", async () => {
    for (const [i, provider, apiKey] of [[1, "anthropic", "key-a"], [2, "openai", "key-a"], [3, "openai", "key-b"]]) {
      await saveDetail({ id: `session-${i}`, provider, model: "m", apiKey,
        session: { id: sessionId, client: "claude" }, providerResponse: null,
        request: { content: "client" }, response: { content: "answer" } });
    }
    await saveDetail({ id: "other-session", provider: "openai", model: "m", apiKey: "key-a",
      session: { id: otherSessionId, client: "codex" }, response: { content: "other" } });

    expect(adapter.get("SELECT sessionId AS id FROM requestDetails WHERE id = ?", ["session-1"]).id).toBe(sessionId);
    expect((await db.getRequestDetailById("session-1")).providerResponse).toBeNull();
    const first = await db.getRequestDetails({ sessionId, pageSize: 2, page: 1 });
    const second = await db.getRequestDetails({ sessionId, pageSize: 2, page: 2 });
    expect(first.pagination).toMatchObject({ totalItems: 3, totalPages: 2, hasNext: true });
    expect(second.pagination).toMatchObject({ totalItems: 3, hasNext: false });
    expect([...first.details, ...second.details].map((d) => d.id).sort()).toEqual(["session-1", "session-2", "session-3"]);
    expect((await db.getRequestDetails({ sessionId, apiKey: "key-a" })).pagination.totalItems).toBe(2);
    expect((await db.getRequestDetails({ sessionId, apiKeys: [], connectionIds: [] })).pagination.totalItems).toBe(0);
  });
});

describe("backupDbLite — excludes requestDetails, keeps critical data", () => {
  it("backup file omits requestDetails rows but keeps other tables", async () => {
    const { backupDbLite } = await import("@/lib/db/backup.js");
    await saveDetail({ id: "bk-1", provider: "openai", model: "m", status: "ok", tokens: {}, request: {}, response: {} });

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bklite-"));
    const dest = backupDbLite(adapter, backupDir);
    expect(fs.existsSync(dest)).toBe(true);

    // Open backup and assert requestDetails is empty, settings present
    const Database = (await import("better-sqlite3")).default;
    const bak = new Database(dest);
    try {
      // requestDetails is fully excluded — table must not exist in the backup
      const rdTable = bak.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='requestDetails'").get();
      expect(rdTable).toBeUndefined();
      // Critical data preserved
      const st = bak.prepare("SELECT COUNT(*) c FROM settings").get();
      expect(st.c).toBeGreaterThanOrEqual(1);
    } finally {
      bak.close();
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  });
});

describe("getDistinctProviders — providers route (no full-row parse)", () => {
  it("returns unique provider list without parsing data blobs", async () => {
    await saveDetail({ id: "dp-1", provider: "openai", model: "m", status: "ok", tokens: {}, request: {}, response: {} });
    await saveDetail({ id: "dp-2", provider: "anthropic", model: "m", status: "ok", tokens: {}, request: {}, response: {} });
    await saveDetail({ id: "dp-3", provider: "openai", model: "m", status: "ok", tokens: {}, request: {}, response: {} });

    const list = await db.getDistinctProviders();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toContain("openai");
    expect(list).toContain("anthropic");
    // No duplicates
    expect(new Set(list).size).toBe(list.length);
  });

  it("skips null providers, returns sorted", async () => {
    const list = await db.getDistinctProviders();
    expect(list.every((p) => p !== null)).toBe(true);
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });
});

describe("token helpers — render-time crash safety", () => {
  it("undefined/null tokens → 0, no throw", () => {
    expect(getInputTokens(undefined)).toBe(0);
    expect(getInputTokens(null)).toBe(0);
    expect(getCachedTokens(undefined)).toBe(0);
    expect(getCacheCreationTokens(null)).toBe(0);
  });

  it("empty object → 0 across all helpers", () => {
    expect(getInputTokens({})).toBe(0);
    expect(getCachedTokens({})).toBe(0);
    expect(getCacheCreationTokens({})).toBe(0);
  });

  it("prompt_tokens preferred, falls back to input_tokens", () => {
    expect(getInputTokens({ prompt_tokens: 100 })).toBe(100);
    expect(getInputTokens({ input_tokens: 50 })).toBe(50);
  });

  it("legacy Claude row (prompt < cache) → returns cache", () => {
    expect(getInputTokens({ prompt_tokens: 10, cached_tokens: 200 })).toBe(200);
  });

  it("cached via cache_read_input_tokens alias", () => {
    expect(getCachedTokens({ cache_read_input_tokens: 42 })).toBe(42);
  });

  it("toLocaleString on helper result never throws", () => {
    expect(() => getInputTokens(undefined).toLocaleString()).not.toThrow();
  });
});

let GET;
function makeReq(query) {
  return new Request(`http://localhost/api/usage/request-details?${query}`);
}
beforeAll(async () => {
  ({ GET } = await import("@/app/api/usage/request-details/route.js"));
});

describe("API route contract — validation boundary", () => {
  it("rejects malformed session IDs", async () => {
    expect((await GET(makeReq("sessionId=not-a-hash"))).status).toBe(400);
  });

  it("filters full session history and redacts prompts and upstream errors for non-admins", async () => {
    const sessionId = "a".repeat(64);
    const detail = await db.getRequestDetailById("session-1");
    await saveDetail({ ...detail, upstream: { error: "prompt leaked here", terminal_event: "error" }, pxpipe: { detail: "secret in transform error", reason: "transform_error" } });
    const res = await GET(makeReq(`sessionId=${sessionId}&pageSize=2&page=2`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination).toMatchObject({ totalItems: 3, totalPages: 2 });
    expect(body.details).toHaveLength(1);
    expect(body.details[0].request).toEqual({ redacted: true });
    expect(body.details[0].response).toEqual({ redacted: true });
    expect(JSON.stringify(body)).not.toContain("prompt leaked here");
    expect(JSON.stringify(body)).not.toContain("secret in transform error");

    const all = await (await GET(makeReq(`sessionId=${sessionId}&pageSize=3`))).json();
    expect(all.details.find((d) => d.id === "session-1").upstream).toMatchObject({
      error: "[redacted]", terminal_event: "error",
    });
    expect(all.details.find((d) => d.id === "session-1").pxpipe).toMatchObject({
      detail: "[redacted]", reason: "transform_error",
    });
  });

  it("shows original bodies to authenticated dashboard admins", async () => {
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    authContext.token = await createDashboardAuthToken();
    try {
      const res = await GET(makeReq(`sessionId=${"a".repeat(64)}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      const row = body.details.find((d) => d.id === "session-1");
      expect(row.request).toEqual({ content: "client" });
      expect(row.upstream.error).toBe("prompt leaked here");
    } finally {
      authContext.token = null;
    }
  });

  it("page=0 → 400 (guard now reachable after NaN-check fix)", async () => {
    const res = await GET(makeReq("page=0"));
    expect(res.status).toBe(400);
  });

  it("page=-5 → 400", async () => {
    const res = await GET(makeReq("page=-5"));
    expect(res.status).toBe(400);
  });

  it("pageSize=101 → 400", async () => {
    const res = await GET(makeReq("pageSize=101"));
    expect(res.status).toBe(400);
  });

  it("pageSize=abc (NaN) → defaults to 20, returns 200", async () => {
    const res = await GET(makeReq("pageSize=abc"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.pageSize).toBe(20);
  });

  it("invalid startDate → route catches, returns 500 (not thrown)", async () => {
    const res = await GET(makeReq("startDate=not-a-date"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("valid request → 200 with details + pagination shape", async () => {
    const res = await GET(makeReq("page=1&pageSize=20"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 20 });
  });
});
