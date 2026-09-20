// Real cross-process exclusivity check for src/lib/db/leases.js — spawns two
// separate OS node processes (not just parallel promises in this process,
// which would never exercise SQLite's actual file locking) that race to
// claim the same lease ids against one shared DATA_DIR. Run 3 times to rule
// out flakiness (see task notes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LOADER = path.join(REPO_ROOT, "tests/fixtures/register-loader.mjs");
const WORKER = path.join(REPO_ROOT, "tests/fixtures/lease-race-worker.mjs");
const WARMUP = path.join(REPO_ROOT, "tests/fixtures/db-warmup.mjs");
const ROUNDS = 30;

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

async function runOneRace() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-lease-race-"));
  const outA = path.join(dataDir, "a.json");
  const outB = path.join(dataDir, "b.json");
  try {
    // Create the DB/schema before the real race starts — see db-warmup.mjs.
    await runNode(WARMUP, [dataDir]);
    await Promise.all([
      runNode(WORKER, [dataDir, outA, String(ROUNDS)]),
      runNode(WORKER, [dataDir, outB, String(ROUNDS)]),
    ]);
    return {
      winsA: JSON.parse(fs.readFileSync(outA, "utf-8")),
      winsB: JSON.parse(fs.readFileSync(outB, "utf-8")),
    };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("job leases — two real OS processes", () => {
  it.each([1, 2, 3])("run %i: every round has exactly one winner across both processes", async (_run) => {
    const { winsA, winsB } = await runOneRace();
    const setA = new Set(winsA);
    const setB = new Set(winsB);

    for (let r = 0; r < ROUNDS; r++) {
      const wonByA = setA.has(r);
      const wonByB = setB.has(r);
      expect(wonByA !== wonByB).toBe(true); // exactly one of the two, never both, never neither
    }
  }, 20_000);
});
