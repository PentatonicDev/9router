// Worker for tests/unit/spend-ledger-concurrency.test.js — spawned as a real
// child process (own module registry + DATA_DIR), same shape as
// usage-daily-sqlite-worker.mjs. Proves recordSpend's seed-then-lock upsert
// doesn't lose updates even on SQLite, where the driver serializes writers
// within one process rather than needing a real lock.
// argv: [apiKey]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const apiKey = process.argv[2];
const connectionId = "conn-fixed";
const baseMs = Date.now();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-spend-sqlite-"));
process.env.DATA_DIR = tempDir;

const { closeDb, getDb } = await import("@/lib/db/kysely.js");
const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");

const calls = [];
for (let i = 0; i < 50; i++) {
  // Distinct timestamps so saveRequestUsage's same-second dedup guard (which
  // matches on timestamp+provider+model+connectionId+apiKey+tokens) treats
  // each call as a separate request rather than collapsing them — the point
  // here is the ledger's lost-update behavior, not the dedup guard.
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
fs.rmSync(tempDir, { recursive: true, force: true });
