// The shared console-log table is what lets the dashboard read every instance's
// output. These exercise the repo's own logic (append, cursor paging, instance
// listing, prune) on a real database file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-console-logs-"));
process.env.INSTANCE_NAME = "pod-a";

let repo;

beforeAll(async () => {
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter();
  repo = await import("@/lib/db/repos/consoleLogsRepo.js");
});

describe("consoleLogsRepo", () => {
  it("is created by the schema sync", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const cols = (await getAdapter()).all("PRAGMA table_info(consoleLogs)").map((c) => c.name);
    expect(cols).toEqual(["id", "instanceId", "timestamp", "line"]);
  });

  it("appends lines stamped with this instance", async () => {
    await repo.clearConsoleLogsFromDb();
    await repo.appendConsoleLogs(["first", "second"]);

    const rows = await repo.getRecentConsoleLogs(10);
    expect(rows.map((r) => r.line)).toEqual(["first", "second"]);
    expect(rows.every((r) => r.instanceId === "pod-a")).toBe(true);
    expect(rows.every((r) => typeof r.id === "number")).toBe(true);
    expect(rows[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pages by cursor without repeating rows", async () => {
    await repo.clearConsoleLogsFromDb();
    await repo.appendConsoleLogs(["a", "b", "c"]);

    const page = await repo.getConsoleLogsSince(0);
    expect(page.map((r) => r.line)).toEqual(["a", "b", "c"]);

    const cursor = page[page.length - 1].id;
    expect(await repo.getConsoleLogsSince(cursor)).toEqual([]);

    await repo.appendConsoleLogs(["d"]);
    expect((await repo.getConsoleLogsSince(cursor)).map((r) => r.line)).toEqual(["d"]);
  });

  it("ignores an empty append", async () => {
    await repo.clearConsoleLogsFromDb();
    await repo.appendConsoleLogs([]);
    expect(await repo.getRecentConsoleLogs(10)).toEqual([]);
  });

  it("lists the instances that wrote", async () => {
    await repo.clearConsoleLogsFromDb();
    await repo.appendConsoleLogs(["from pod-a"]);
    const instances = await repo.getConsoleLogInstances();
    expect(instances.map((i) => i.instanceId)).toEqual(["pod-a"]);
    expect(instances[0].lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops instances that stopped writing", async () => {
    await repo.clearConsoleLogsFromDb();
    const { getDb } = await import("@/lib/db/kysely.js");
    const db = await getDb();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.insertInto("consoleLogs").values({ instanceId: "gone-pod", timestamp: stale, line: "old" }).execute();
    await repo.appendConsoleLogs(["fresh"]);
    const ids = (await repo.getConsoleLogInstances()).map((i) => i.instanceId);
    expect(ids).not.toContain("gone-pod");
    expect(ids).toHaveLength(1);
    const all = (await repo.getConsoleLogInstances({ activeWithinMs: 2 * 60 * 60 * 1000 })).map((i) => i.instanceId);
    expect(all).toContain("gone-pod");
  });

  it("clears every row", async () => {
    await repo.appendConsoleLogs(["leftover"]);
    await repo.clearConsoleLogsFromDb();
    expect(await repo.getRecentConsoleLogs(10)).toEqual([]);
  });

  it("keeps the newest rows when the cap is exceeded", async () => {
    await repo.clearConsoleLogsFromDb();
    // MAX_ROWS is 5000; seed just over it so the prune path actually runs.
    const batch = Array.from({ length: 2600 }, (_, i) => `line-${i}`);
    await repo.appendConsoleLogs(batch);
    await repo.appendConsoleLogs(batch.map((l) => `${l}-b`));

    const remaining = await repo.getConsoleLogsSince(0, 6000);
    expect(remaining.length).toBeLessThanOrEqual(5000);
    // Oldest-first prune: the tail of the newest batch survives, the head does not.
    expect(remaining[remaining.length - 1].line).toBe("line-2599-b");
    expect(remaining.some((r) => r.line === "line-0")).toBe(false);
  }, 60000);
});
