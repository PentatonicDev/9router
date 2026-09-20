// Worker for tests/unit/usage-daily-concurrency.test.js — spawned as a real
// child process (via the alias loader) so it gets its own module registry and
// DATA_DIR, independent of any other test's SQLite instance.
// argv: [dateKey]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dateKey = process.argv[2];
const timestamp = `${dateKey}T12:00:00.000Z`;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-sqlite-"));
process.env.DATA_DIR = tempDir;

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
fs.rmSync(tempDir, { recursive: true, force: true });
