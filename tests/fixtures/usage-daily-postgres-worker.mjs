// Worker for tests/unit/usage-daily-concurrency.test.js — real Postgres proof
// that saveRequestUsage's usageDaily read-modify-write is serialized per
// dateKey (SELECT ... FOR UPDATE) instead of losing concurrent updates under
// READ COMMITTED. Spawned as its own process so DATABASE_URL only affects this
// run. argv: [dateKey]. Env: DATABASE_URL (required).
const dateKey = process.argv[2];
const timestamp = `${dateKey}T12:00:00.000Z`;

const { closeDb, getDb } = await import("@/lib/db/kysely.js");
const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");

const calls = [];
for (let i = 0; i < 50; i++) {
  calls.push(saveRequestUsage({
    timestamp,
    provider: "testprov",
    model: "testmodel",
    apiKey: `k${i}`,
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
  }));
}
await Promise.all(calls);

const db = await getDb();
const row = await db.selectFrom("usageDaily").select("data").where("dateKey", "=", dateKey).executeTakeFirst();
const day = row ? JSON.parse(row.data) : null;

process.stdout.write(JSON.stringify({
  requests: day?.requests ?? 0,
  promptTokens: day?.promptTokens ?? 0,
  completionTokens: day?.completionTokens ?? 0,
}));

await closeDb();
