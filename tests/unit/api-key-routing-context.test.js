// Router hot path needs validity, owner, label and account bindings for one key.
// In distributed mode each repository call is a Postgres round trip, so the
// consolidated lookup must return all four from one row without changing their
// existing semantics.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-key-routing-"));

let repo;
let db;

beforeAll(async () => {
  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
});

describe("getApiKeyRoutingContext", () => {
  it("returns one snapshot with validity, owner, name and bindings", async () => {
    const created = await repo.createApiKey("Claude Code", "machine-a", null, "dev@example.com");
    await repo.updateApiKey(created.id, {
      allowedConnectionIds: ["conn-a", "conn-b", "conn-a"],
    });

    expect(await repo.getApiKeyRoutingContext(created.key)).toEqual({
      valid: true,
      owner: "dev@example.com",
      name: "Claude Code",
      management: false,
      allowedConnectionIds: ["conn-a", "conn-b"],
    });
  });

  it("reflects inactive keys", async () => {
    const created = await repo.createApiKey("Disabled", "machine-b");
    await repo.updateApiKey(created.id, { isActive: false });
    expect((await repo.getApiKeyRoutingContext(created.key)).valid).toBe(false);
  });

  it("keeps missing/unbound key semantics", async () => {
    expect(await repo.getApiKeyRoutingContext(null)).toEqual({
      valid: false, owner: null, name: null, management: false, allowedConnectionIds: null,
    });
    expect(await repo.getApiKeyRoutingContext("sk-missing")).toEqual({
      valid: false, owner: null, name: null, management: false, allowedConnectionIds: null,
    });
  });

  it("is one SELECT against the apiKeys row", async () => {
    const created = await repo.createApiKey("Measured", "machine-c");
    let reads = 0;
    const originalAll = db.all.bind(db);
    db.all = (sql, params) => {
      if (/select.+from\s+["`]?apiKeys["`]?/is.test(sql)) reads++;
      return originalAll(sql, params);
    };

    try {
      await repo.getApiKeyRoutingContext(created.key);
    } finally {
      db.all = originalAll;
    }
    expect(reads).toBe(1);
  });
});
