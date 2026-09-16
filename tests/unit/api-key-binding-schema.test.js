import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Exercises the real SQLite driver: the additive schema sync must create the
// column, and the JSON round-trip must survive whichever adapter is in use.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-key-binding-"));

let db;
let repo;
let created;

beforeAll(async () => {
  ({ getAdapter: db } = await import("@/lib/db/driver.js"));
  db = await db();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  created = await repo.createApiKey("binding-test", "machine-1");
});

describe("apiKeys.allowedConnectionIds", () => {
  it("is created by the additive schema sync", () => {
    const columns = db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(columns).toContain("allowedConnectionIds");
  });

  it("starts unrestricted", async () => {
    expect(created.allowedConnectionIds).toBeNull();
    expect(await repo.getApiKeyAllowedConnectionIds(created.key)).toBeNull();
  });

  it("round-trips a deduped list through the driver", async () => {
    const saved = await repo.updateApiKey(created.id, { allowedConnectionIds: ["conn-b", "conn-a", "conn-b"] });
    expect(saved.allowedConnectionIds).toEqual(["conn-b", "conn-a"]);
    expect((await repo.getApiKeyById(created.id)).allowedConnectionIds).toEqual(["conn-b", "conn-a"]);
    expect(await repo.getApiKeyAllowedConnectionIds(created.key)).toEqual(["conn-b", "conn-a"]);
  });

  it("survives an unrelated update", async () => {
    const toggled = await repo.updateApiKey(created.id, { isActive: false });
    expect(toggled.allowedConnectionIds).toEqual(["conn-b", "conn-a"]);
  });

  it("stores an empty list as SQL NULL (unrestricted)", async () => {
    const cleared = await repo.updateApiKey(created.id, { allowedConnectionIds: [] });
    expect(cleared.allowedConnectionIds).toBeNull();
    expect(db.get(`SELECT allowedConnectionIds AS v FROM apiKeys WHERE id = ?`, [created.id]).v).toBeNull();
  });
});
