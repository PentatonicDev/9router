// Covers the cross-instance coordination added to syncModelCatalog(): only the
// lease winner calls models.dev, and a loser adopts the winner's catalog from
// the shared kv row instead of ending up with no catalog at all (each instance
// has its own DATA_DIR/CATALOG_FILE — see src/lib/modelCatalog/sync.js header).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let catalogFile;
let closeDb;
let claimLease;
let releaseLease;
let catalogKv;
let syncModelCatalog;
let CATALOG_LEASE_ID;
let getCatalogModalities;
let invalidateCatalog;

const upstream = { zai: { models: { "glm-4.6v": { modalities: { input: ["text", "image"] } } } } };
const visionCaps = {
  vision: true,
  pdf: false,
  audioInput: false,
  videoInput: false,
  imageOutput: false,
  audioOutput: false,
  reasoning: false,
  tools: true,
};
const realFetch = globalThis.fetch;

function mockFetch(impl) {
  globalThis.fetch = impl;
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-catalog-lease-"));
  process.env.DATA_DIR = tempDir;
  catalogFile = path.join(tempDir, "model-catalog.json");

  const kysely = await import("@/lib/db/kysely.js");
  closeDb = kysely.closeDb;
  await kysely.getDb(); // force schema creation before any test runs

  ({ claimLease, releaseLease } = await import("@/lib/db/leases.js"));
  const { makeKv } = await import("@/lib/db/helpers/kvStore.js");
  catalogKv = makeKv("modelCatalog");
  ({ syncModelCatalog, CATALOG_LEASE_ID } = await import("../../src/lib/modelCatalog/sync.js"));
  ({ getCatalogModalities, invalidateCatalog } = await import("../../open-sse/providers/catalogOverride.js"));
});

afterAll(async () => {
  await closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(async () => {
  await catalogKv.clear();
  fs.rmSync(catalogFile, { force: true });
  invalidateCatalog();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("model catalog — cross-instance lease", () => {
  it("skips models.dev and reports unchanged when another instance holds the lease and kv has nothing yet", async () => {
    const foreignHolder = await claimLease(CATALOG_LEASE_ID, 60_000, { holder: "other-instance:1" });
    expect(foreignHolder).toBe("other-instance:1");

    let fetchCalled = false;
    mockFetch(async () => { fetchCalled = true; throw new Error("must not call models.dev"); });

    try {
      const result = await syncModelCatalog();
      expect(fetchCalled).toBe(false);
      expect(result).toMatchObject({ status: "unchanged" });
      expect(fs.existsSync(catalogFile)).toBe(false);
    } finally {
      await releaseLease(CATALOG_LEASE_ID, "other-instance:1");
    }
  });

  it("wins the lease, fetches upstream, writes the local file, and mirrors the result into kv", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      headers: new Map([["etag", 'W/"v1"']]),
      json: async () => upstream,
    }));

    const result = await syncModelCatalog();

    expect(result.status).toBe("updated");
    const written = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    expect(written.etag).toBe('W/"v1"');
    expect(getCatalogModalities("zai", "glm-4.6v")).toEqual(visionCaps);

    const shared = await catalogKv.get("catalog");
    expect(shared.etag).toBe('W/"v1"');
    expect(shared.syncedAt).toBeTypeOf("number");
  });

  it("adopts a winner's catalog from kv when it loses the lease, without calling models.dev", async () => {
    // Simulate another instance's already-completed winning sync.
    const winnerPayload = { v: 4, etag: 'W/"from-winner"', syncedAt: Date.now(), models: { "zai:glm-4.6v": visionCaps }, providers: {}, pricing: {} };
    await catalogKv.set("catalog", winnerPayload);

    const foreignHolder = await claimLease(CATALOG_LEASE_ID, 60_000, { holder: "other-instance:2" });
    expect(foreignHolder).toBe("other-instance:2");

    let fetchCalled = false;
    mockFetch(async () => { fetchCalled = true; throw new Error("must not call models.dev"); });

    try {
      const result = await syncModelCatalog();
      expect(fetchCalled).toBe(false);
      expect(result).toMatchObject({ status: "adopted", etag: 'W/"from-winner"' });

      const written = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
      expect(written).toEqual(winnerPayload);
      expect(getCatalogModalities("zai", "glm-4.6v")).toEqual(visionCaps);
    } finally {
      await releaseLease(CATALOG_LEASE_ID, "other-instance:2");
    }
  });
});
