import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-upgrade-"));
process.env.DATA_DIR = dataDir;

const { createNodeSqliteAdapter } = await import("@/lib/db/adapters/nodeSqliteAdapter.js");
const { runMigrationOnce } = await import("@/lib/db/migrate.js");
const dbFile = path.join(dataDir, "db", "data.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

describe("request details additive session migration", () => {
  it("preserves old rows and adds session column and index", async () => {
    const original = await createNodeSqliteAdapter(dbFile);
    try {
      await runMigrationOnce(original);
      original.exec("DROP INDEX idx_rd_session");
      original.exec("ALTER TABLE requestDetails DROP COLUMN sessionId");
      original.run("INSERT INTO requestDetails(id, timestamp, data) VALUES(?, ?, ?)",
        ["old-row", "2026-09-27T00:00:00.000Z", '{"id":"old-row"}']);
      original.run("UPDATE _meta SET value = ? WHERE key = ?", ["10", "backupSchemaVersion"]);
    } finally {
      original.close();
    }

    const upgraded = await createNodeSqliteAdapter(dbFile);
    try {
      await runMigrationOnce(upgraded);
      expect(upgraded.all("PRAGMA table_info(requestDetails)").map((c) => c.name)).toContain("sessionId");
      expect(upgraded.all("PRAGMA index_list(requestDetails)").map((i) => i.name)).toContain("idx_rd_session");
      expect(upgraded.get("SELECT id, sessionId FROM requestDetails WHERE id = ?", ["old-row"])).toMatchObject({ id: "old-row", sessionId: null });
    } finally {
      upgraded.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
