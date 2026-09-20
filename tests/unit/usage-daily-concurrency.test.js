// Covers the usageDaily lost-update fix in src/lib/db/repos/usageRepo.js:
// concurrent saveRequestUsage calls for the same dateKey used to read the same
// JSON aggregate and clobber each other's writes on Postgres (READ COMMITTED).
// Each case is a real child process (not just parallel promises in this
// process) so the DB driver's actual locking is exercised — see
// tests/unit/leases-two-process.test.js for the same pattern.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LOADER = path.join(REPO_ROOT, "tests/fixtures/register-loader.mjs");
const SQLITE_WORKER = path.join(REPO_ROOT, "tests/fixtures/usage-daily-sqlite-worker.mjs");
const PG_WORKER = path.join(REPO_ROOT, "tests/fixtures/usage-daily-postgres-worker.mjs");

// Set LEASE_TEST_DATABASE_URL (shared with the leases suite) or
// USAGE_TEST_DATABASE_URL to run the Postgres proof against a real database;
// otherwise it's skipped.
const PG_URL = process.env.USAGE_TEST_DATABASE_URL || process.env.LEASE_TEST_DATABASE_URL || "";

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
      // The worker's own DB layer may log setup lines to stdout before the
      // result; the result is always the JSON on the last line.
      const lastLine = stdout.trim().split("\n").pop();
      try { resolve(JSON.parse(lastLine)); }
      catch (e) { reject(new Error(`could not parse worker output: ${stdout}`)); }
    });
  });
}

describe("usageDaily concurrency", () => {
  it("SQLite (local, single process): 50 concurrent calls all land", async () => {
    const result = await runWorker(SQLITE_WORKER, ["2026-04-01"]);
    expect(result).toEqual({ requests: 50, promptTokens: 500, completionTokens: 250 });
  });

  it.skipIf(!PG_URL).each([1, 2, 3])(
    "Postgres run %i: 50 concurrent transactions on the same dateKey lose nothing",
    async (run) => {
      const result = await runWorker(PG_WORKER, [`2026-05-0${run}`], { DATABASE_URL: PG_URL });
      expect(result).toEqual({ requests: 50, promptTokens: 500, completionTokens: 250 });
    }
  );
});
