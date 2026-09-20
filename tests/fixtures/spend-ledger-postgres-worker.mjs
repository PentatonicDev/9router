// Worker for tests/unit/spend-ledger-concurrency.test.js — real Postgres proof
// that spendLedgerRepo.js's recordSpend (seed + SELECT ... FOR UPDATE) is
// serialized per (apiKey, connectionId, periodKey) instead of losing
// concurrent updates under READ COMMITTED. Mirrors
// tests/fixtures/usage-daily-postgres-worker.mjs. argv: [apiKey]. Env:
// DATABASE_URL (required).
const apiKey = process.argv[2];
const connectionId = "conn-fixed";
const baseMs = Date.now();

const { closeDb, getDb } = await import("@/lib/db/kysely.js");
const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");

const calls = [];
for (let i = 0; i < 50; i++) {
  calls.push(saveRequestUsage({
    timestamp: new Date(baseMs + i).toISOString(),
    provider: "testprov",
    model: "claude-haiku-4-5-20251001", // MODEL_PRICING: input $1.00/1M, output $5.00/1M
    apiKey,
    connectionId,
    tokens: { prompt_tokens: 10000, completion_tokens: 0 }, // cost = 0.01/call
  }));
}
await Promise.all(calls);

const db = await getDb();
const row = await db.selectFrom("spendLedger").select("costUsd")
  .where("apiKey", "=", apiKey).where("connectionId", "=", connectionId).where("periodKey", "=", "total")
  .executeTakeFirst();

process.stdout.write(JSON.stringify({ costUsd: row?.costUsd ?? 0 }));

await closeDb();
