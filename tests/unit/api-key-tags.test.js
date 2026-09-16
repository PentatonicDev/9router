import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-key-tags-"));

let repo;
let db;

beforeAll(async () => {
  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
});

describe("apiKeys.tags", () => {
  it("is created by the additive schema sync", () => {
    expect(db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name)).toContain("tags");
  });

  it("defaults to an empty list", async () => {
    const key = await repo.createApiKey("no-tags", "m1");
    expect(key.tags).toEqual([]);
    expect((await repo.getApiKeyById(key.id)).tags).toEqual([]);
  });

  it("round-trips tags given at creation", async () => {
    const key = await repo.createApiKey("tagged", "m1", ["prod", "backend"]);
    expect((await repo.getApiKeyById(key.id)).tags).toEqual(["prod", "backend"]);
  });

  it("renames without dropping tags", async () => {
    const key = await repo.createApiKey("old-name", "m1", ["keep"]);
    const renamed = await repo.updateApiKey(key.id, { name: "new-name" });
    expect(renamed.name).toBe("new-name");
    expect(renamed.tags).toEqual(["keep"]);
  });

  it("trims, drops blanks and de-duplicates case-insensitively", async () => {
    const key = await repo.createApiKey("messy", "m1");
    const saved = await repo.updateApiKey(key.id, { tags: ["  prod  ", "", "PROD", "backend", "   "] });
    expect(saved.tags).toEqual(["prod", "backend"]);
  });

  it("caps tag length and count", async () => {
    const key = await repo.createApiKey("bulky", "m1");
    const saved = await repo.updateApiKey(key.id, {
      tags: ["x".repeat(80), ...Array.from({ length: 30 }, (_, i) => `t${i}`)],
    });
    expect(saved.tags).toHaveLength(20);
    expect(saved.tags[0]).toHaveLength(32);
  });

  it("clears tags with an empty array and stores SQL NULL", async () => {
    const key = await repo.createApiKey("clearable", "m1", ["gone"]);
    const cleared = await repo.updateApiKey(key.id, { tags: [] });
    expect(cleared.tags).toEqual([]);
    expect(db.get(`SELECT tags AS v FROM apiKeys WHERE id = ?`, [key.id]).v).toBeNull();
  });

  it("keeps tags and account bindings independent", async () => {
    const key = await repo.createApiKey("both", "m1", ["prod"]);
    const bound = await repo.updateApiKey(key.id, { allowedConnectionIds: ["conn-1"] });
    expect(bound.tags).toEqual(["prod"]);
    expect(bound.allowedConnectionIds).toEqual(["conn-1"]);

    const retagged = await repo.updateApiKey(key.id, { tags: ["staging"] });
    expect(retagged.allowedConnectionIds).toEqual(["conn-1"]);
  });
});
