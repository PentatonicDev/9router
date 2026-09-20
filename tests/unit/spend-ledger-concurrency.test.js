// Covers spendLedgerRepo.js's recordSpend lost-update fix: concurrent
// saveRequestUsage calls for the same (apiKey, connectionId) used to read the
// same costUsd and clobber each other's addition on Postgres (READ
// COMMITTED). Each case is a real child process, not parallel promises in
// this process, so the DB driver's actual locking is exercised — see
// tests/unit/usage-daily-concurrency.test.js for the same pattern.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LOADER = path.join(REPO_ROOT, "tests/fixtures/register-loader.mjs");
const SQLITE_WORKER = path.join(REPO_ROOT, "tests/fixtures/spend-ledger-sqlite-worker.mjs");
const PG_WORKER = path.join(REPO_ROOT, "tests/fixtures/spend-ledger-postgres-worker.mjs");

// Set SPEND_TEST_DATABASE_URL (or reuse USAGE_TEST_DATABASE_URL /
// LEASE_TEST_DATABASE_URL) to run the Postgres proof against a real database;
// otherwise it's skipped.
const PG_URL = process.env.SPEND_TEST_DATABASE_URL || process.env.USAGE_TEST_DATABASE_URL || process.env.LEASE_TEST_DATABASE_URL || "";

function runWorker(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", LOADER, script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error(`${script} exited with ${code}: ${stderr}`)); return; }
      const lastLine = stdout.trim().split("\n").pop();
      try { resolve(JSON.parse(lastLine)); }
      catch (e) { reject(new Error(`could not parse worker output: ${stdout}`)); }
    });
  });
}

// A fresh apiKey per test run (not just per run index) — the Postgres target
// is a real, persistent database (unlike the SQLite worker's throwaway temp
// dir), so a fixed id would accumulate cost across repeated local runs
// instead of proving the lost-update fix.
const runId = Date.now();

describe("spendLedger concurrency", () => {
  it("SQLite (local, single process): 50 concurrent calls on the same key×connection sum exactly", async () => {
    const result = await runWorker(SQLITE_WORKER, [`sk-sqlite-concurrency-${runId}`]);
    expect(result.costUsd).toBeCloseTo(0.5, 6);
  });

  it.skipIf(!PG_URL).each([1, 2, 3])(
    "Postgres run %i: 50 concurrent transactions on the same key×connection lose nothing",
    async (run) => {
      const result = await runWorker(PG_WORKER, [`sk-pg-concurrency-${runId}-${run}`], { DATABASE_URL: PG_URL });
      expect(result.costUsd).toBeCloseTo(0.5, 6);
    }
  );
});
