// usageScope.js: the parameterized visibility computation
// (getUsageVisibilityForFilter) and the per-row predicate (canSeeUsageRow)
// that request-details/usage routes scope by. getUsageVisibility() itself is
// a thin, untested-here wrapper (cookie-based getScopeFilter() + this).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let getUsageVisibilityForFilter;
let canSeeUsageRow;

let keyA, keyB, sharedKey;
let connA, connB, sharedConn;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-visibility-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();

  keyA = await db.createApiKey("Key A", "machine-a", null, "owner-a@example.com");
  keyB = await db.createApiKey("Key B", "machine-b", null, "owner-b@example.com");
  sharedKey = await db.createApiKey("Shared", "machine-shared");

  connA = await db.createProviderConnection({ provider: "test", authType: "apikey", name: "conn-a", apiKey: "k-a", owner: "owner-a@example.com" });
  connB = await db.createProviderConnection({ provider: "test", authType: "apikey", name: "conn-b", apiKey: "k-b", owner: "owner-b@example.com" });
  sharedConn = await db.createProviderConnection({ provider: "test", authType: "apikey", name: "conn-shared", apiKey: "k-shared" });

  ({ getUsageVisibilityForFilter, canSeeUsageRow } = await import("@/lib/auth/usageScope.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("getUsageVisibilityForFilter", () => {
  it("null filter → null (unrestricted)", async () => {
    expect(await getUsageVisibilityForFilter(null)).toBeNull();
  });

  it("owner filter → own + shared resources only, not the other owner's", async () => {
    const visibility = await getUsageVisibilityForFilter({ owner: "owner-a@example.com" });
    expect(visibility.apiKeys.has(keyA.key)).toBe(true);
    expect(visibility.apiKeys.has(sharedKey.key)).toBe(true);
    expect(visibility.apiKeys.has(keyB.key)).toBe(false);
    expect(visibility.connectionIds.has(connA.id)).toBe(true);
    expect(visibility.connectionIds.has(sharedConn.id)).toBe(true);
    expect(visibility.connectionIds.has(connB.id)).toBe(false);
  });
});

describe("canSeeUsageRow", () => {
  it("null visibility → always visible", () => {
    expect(canSeeUsageRow({ apiKey: keyB.key }, null)).toBe(true);
  });

  it("row with no connectionId/apiKey (local/unattributed traffic) → visible to everyone", async () => {
    const visibility = await getUsageVisibilityForFilter({ owner: "owner-a@example.com" });
    expect(canSeeUsageRow({}, visibility)).toBe(true);
  });

  it("row's raw apiKey outside the visible set → excluded", async () => {
    const visibility = await getUsageVisibilityForFilter({ owner: "owner-a@example.com" });
    expect(canSeeUsageRow({ apiKey: keyB.key }, visibility)).toBe(false);
  });

  it("row's raw apiKey inside the visible set → included", async () => {
    const visibility = await getUsageVisibilityForFilter({ owner: "owner-a@example.com" });
    expect(canSeeUsageRow({ apiKey: keyA.key }, visibility)).toBe(true);
  });

  it("row's connectionId outside the visible set → excluded", async () => {
    const visibility = await getUsageVisibilityForFilter({ owner: "owner-a@example.com" });
    expect(canSeeUsageRow({ connectionId: connB.id }, visibility)).toBe(false);
  });

  it("masked-key-only row (no raw apiKey stored) matches on the masked form", async () => {
    const { maskApiKey } = await import("@/lib/db/helpers/maskKey.js");
    const visibility = await getUsageVisibilityForFilter({ owner: "owner-a@example.com" });
    // Isolated from the raw-apiKey check by omitting `apiKey` entirely — only the
    // apiKeyMasked branch of canSeeUsageRow can decide this case.
    expect(canSeeUsageRow({ apiKeyMasked: maskApiKey(keyA.key) }, visibility)).toBe(true);
    expect(canSeeUsageRow({ apiKeyMasked: maskApiKey(keyB.key) }, visibility)).toBe(false);
  });
});
