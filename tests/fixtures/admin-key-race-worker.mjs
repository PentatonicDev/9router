// Worker for tests/unit/admin-key.test.js — real DB proof that
// idx_ak_admin_owner (a partial unique index on apiKeys(owner) WHERE
// kind='admin') actually rejects a second admin key for the same owner, on
// both SQLite and Postgres. Spawned as its own process so DATABASE_URL (or
// DATA_DIR for SQLite) only affects this run. This bypasses the route-level
// getAdminKeyByOwner pre-check on purpose — that check is a TOCTOU race by
// itself; only the DB constraint actually closes it. argv: [owner].
// Env: DATABASE_URL (Postgres) or DATA_DIR (SQLite).
const owner = process.argv[2];

const { closeDb } = await import("@/lib/db/kysely.js");
const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");

const results = await Promise.allSettled([
  createApiKey("Admin race 1", "machine-race-1", null, owner, "admin"),
  createApiKey("Admin race 2", "machine-race-2", null, owner, "admin"),
]);

const fulfilled = results.filter((r) => r.status === "fulfilled").length;
const rejected = results.filter((r) => r.status === "rejected");

process.stdout.write(JSON.stringify({
  fulfilled,
  rejectedCount: rejected.length,
  // SQLite: "UNIQUE constraint failed"; Postgres: driver surfaces code 23505.
  rejectedLooksLikeUniqueViolation: rejected.every((r) => {
    const msg = String(r.reason?.message || "");
    return r.reason?.code === "23505" || /unique/i.test(msg);
  }),
}));

await closeDb();
