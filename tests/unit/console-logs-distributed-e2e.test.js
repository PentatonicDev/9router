// End-to-end of the distributed console-log path, without a running server:
// a line logged by "instance A" must be visible through the same read path the
// dashboard's SSE route uses, and be attributed to the instance that wrote it.
//
// This is the behaviour the dashboard depends on: in distributed mode each
// process only holds its own ring buffer, so the shared table is the only place
// where one instance can see another instance's output.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "9r-console-e2e-"));
process.env.DATA_DIR = dataDir;

let repo;
let mode;

beforeAll(async () => {
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter();
  repo = await import("@/lib/db/repos/consoleLogsRepo.js");
  mode = await import("@/lib/db/mode.js");
});

afterAll(() => {
  delete process.env.DATABASE_URL;
});

describe("distributed console log visibility", () => {
  it("attributes each line to the instance that wrote it", async () => {
    await repo.clearConsoleLogsFromDb();

    // Instance A writes...
    process.env.INSTANCE_NAME = "9router-7d9f-abc12";
    await repo.appendConsoleLogs(["[12:00:00] ❌ [AUTH] token expired"]);
    // ...and so does instance B.
    process.env.INSTANCE_NAME = "9router-7d9f-xyz98";
    await repo.appendConsoleLogs(["[12:00:01] ℹ️  [CHAT] routed"]);

    const rows = await repo.getRecentConsoleLogs(50);
    expect(rows).toHaveLength(2);
    expect(rows[0].instanceId).toBe("9router-7d9f-abc12");
    expect(rows[0].line).toContain("token expired");
    expect(rows[1].instanceId).toBe("9router-7d9f-xyz98");

    const instances = await repo.getConsoleLogInstances();
    expect(instances.map((i) => i.instanceId))
      .toEqual(["9router-7d9f-abc12", "9router-7d9f-xyz98"]);
  });

  it("delivers every instance's lines through the SSE cursor, in order", async () => {
    await repo.clearConsoleLogsFromDb();
    let cursor = 0;
    const seen = [];

    // Interleave writers across polls, the way a real cluster behaves.
    for (const [instance, line] of [
      ["pod-a", "a1"],
      ["pod-b", "b1"],
      ["pod-a", "a2"],
      ["pod-b", "b2"],
    ]) {
      process.env.INSTANCE_NAME = instance;
      await repo.appendConsoleLogs([line]);
      for (const row of await repo.getConsoleLogsSince(cursor)) {
        seen.push(`${row.instanceId}:${row.line}`);
        cursor = row.id;
      }
    }

    expect(seen).toEqual(["pod-a:a1", "pod-b:b1", "pod-a:a2", "pod-b:b2"]);
  });

  it("reads the shared table only in distributed mode", async () => {
    // The sink in consoleLogBuffer is gated on this, so it is the switch that
    // decides whether a line ever reaches the table at all.
    delete process.env.DATABASE_URL;
    expect(mode.isDistributed()).toBe(false);

    process.env.DATABASE_URL = "postgres://user:pass@db:5432/ninerouter";
    expect(mode.isDistributed()).toBe(true);
    delete process.env.DATABASE_URL;
  });
});
