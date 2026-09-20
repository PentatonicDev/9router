// Run once, sequentially, before the two racer processes in
// tests/unit/leases-two-process.test.js start, so the DB file/schema already
// exist when the real race begins. Without this, two brand-new processes can
// hit SQLite's own first-boot driver-selection race (see driver.js) — a
// separate, pre-existing fragility unrelated to what this test is checking.
process.env.DATA_DIR = process.argv[2];
const { getDb } = await import("../../src/lib/db/kysely.js");
await getDb();
