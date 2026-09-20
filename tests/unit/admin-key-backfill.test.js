// kysely.js's backfillAdminKeyKind() flips legacy `management=1` rows to
// `kind='admin'` on every boot. Seeds real pre-migration-shaped rows into a
// real SQLite file, then forces a second boot (closeDb() + getDb(), exactly
// what a process restart does) to exercise the actual init() code path —
// not a reimplementation of its SQL.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const tempDir = mkdtempSync(join(tmpdir(), "9router-admin-backfill-"));
process.env.DATA_DIR = tempDir;

let getDb, closeDb;

beforeAll(async () => {
  ({ getDb, closeDb } = await import("@/lib/db/kysely.js"));
  await getDb(); // first boot: creates schema, no rows yet, backfill no-ops
});

afterAll(async () => {
  await closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

let seq = 0;
async function seedRow(db, { owner, management, kind = "usage", createdAt }) {
  const id = `row-${++seq}`;
  await db.insertInto("apiKeys").values({
    id, key: `key-${id}`, name: id, machineId: "m", isActive: 1,
    management, kind, owner: owner ?? null, createdAt,
  }).execute();
  return id;
}

async function kindOf(db, id) {
  const row = await db.selectFrom("apiKeys").select("kind").where("id", "=", id).executeTakeFirst();
  return row?.kind;
}

// Forces a real second boot against the same on-disk file, the same way a
// process restart would: clears kysely.js's process-cached instance so
// getDb() re-runs init() -> backfillAdminKeyKind() on the existing data.
async function reboot() {
  const db = await getDb();
  await db.destroy().catch(() => {});
  const kyselyModule = await import("@/lib/db/kysely.js");
  // closeDb() also calls destroy(); already destroyed above, so just clear
  // the cache fields directly via closeDb() (idempotent against a dead handle).
  await kyselyModule.closeDb();
  return kyselyModule.getDb();
}

describe("boot backfill: management=1 -> kind='admin'", () => {
  it("flips a legacy management=1, kind='usage', owned row on the next boot", async () => {
    const db = await getDb();
    const id = await seedRow(db, { owner: "legacy-owner", management: 1, createdAt: "2020-01-01T00:00:00.000Z" });
    expect(await kindOf(db, id)).toBe("usage");

    const rebooted = await reboot();
    expect(await kindOf(rebooted, id)).toBe("admin");
  });

  it("leaves a management=0 row alone", async () => {
    const db = await getDb();
    const id = await seedRow(db, { owner: "routing-owner", management: 0, createdAt: "2020-01-02T00:00:00.000Z" });

    const rebooted = await reboot();
    expect(await kindOf(rebooted, id)).toBe("usage");
  });

  it("leaves an ownerless management=1 row alone (idx_ak_admin_owner needs a real owner)", async () => {
    const db = await getDb();
    const id = await seedRow(db, { owner: null, management: 1, createdAt: "2020-01-03T00:00:00.000Z" });

    const rebooted = await reboot();
    expect(await kindOf(rebooted, id)).toBe("usage");
  });

  it("dedupes two management=1 rows sharing an owner: only the oldest flips, boot does not crash on idx_ak_admin_owner", async () => {
    const db = await getDb();
    const owner = "dup-owner";
    const older = await seedRow(db, { owner, management: 1, createdAt: "2019-01-01T00:00:00.000Z" });
    const newer = await seedRow(db, { owner, management: 1, createdAt: "2019-06-01T00:00:00.000Z" });

    const rebooted = await reboot();
    expect(await kindOf(rebooted, older)).toBe("admin");
    expect(await kindOf(rebooted, newer)).toBe("usage");
  });
});
