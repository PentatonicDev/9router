// Real cross-process exclusivity check for the OAuth refresh coordinator
// (src/lib/db/refreshCoordinator.js + open-sse/services/oauthCredentialManager.js's
// setRefreshCoordinator hook) — spawns two separate OS node processes racing
// to refresh the SAME connection's token, exactly the scenario from the
// incident this fixes: two instances booting together both refresh Claude and
// the loser submits an already-rotated refresh token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LOADER = path.join(REPO_ROOT, "tests/fixtures/register-loader.mjs");
const WORKER = path.join(REPO_ROOT, "tests/fixtures/refresh-coordinator-race-worker.mjs");

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", LOADER, script, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`${script} exited with ${code}: ${stderr}`));
      else resolve();
    });
  });
}

describe("oauth refresh coordinator — two real OS processes", () => {
  it("exactly one process calls the provider; both end up holding the new token", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-refresh-race-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      // Seed the connection before the race starts (same DB the two worker
      // processes will race against), same warmup idea as
      // tests/unit/leases-two-process.test.js's db-warmup.mjs.
      process.env.DATA_DIR = dataDir;
      const { createProviderConnection } = await import("@/lib/db/index.js");
      const connection = await createProviderConnection({
        provider: "claude",
        authType: "oauth",
        email: "refresh-race@example.com",
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      const outA = path.join(dataDir, "a.json");
      const outB = path.join(dataDir, "b.json");
      await Promise.all([
        runNode(WORKER, [dataDir, connection.id, outA]),
        runNode(WORKER, [dataDir, connection.id, outB]),
      ]);

      const a = JSON.parse(fs.readFileSync(outA, "utf-8"));
      const b = JSON.parse(fs.readFileSync(outB, "utf-8"));

      // The whole point: never two provider calls for one connection at once.
      expect(a.fetchCallCount + b.fetchCallCount).toBe(1);
      // Both processes converge on the same rotated token — the loser via
      // reload() after the winner persists, not by sending the stale one.
      expect(a.accessToken).toBe("new-access-token");
      expect(b.accessToken).toBe("new-access-token");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
    }
  }, 20_000);
});
