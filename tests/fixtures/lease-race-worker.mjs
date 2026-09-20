// Spawned as a separate OS process by tests/unit/leases-two-process.test.js —
// the whole point is real inter-process contention on the same SQLite file,
// which nothing inside a single Node process (even parallel promises) can
// exercise. Two of these run against the same DATA_DIR and race to claim
// "race:<round>" for a long TTL each round; the first claimant keeps it for
// the rest of the run, so exactly one of the two must win each round.
import fs from "node:fs";

const [, , dataDir, outFile, roundsArg] = process.argv;
process.env.DATA_DIR = dataDir;
const rounds = Number(roundsArg || 30);

const { claimLease } = await import("../../src/lib/db/leases.js");

const wins = [];
for (let r = 0; r < rounds; r++) {
  // Small random jitter so the two processes don't always hit the DB in the
  // same order, without serializing them into a fake non-race.
  await new Promise((res) => setTimeout(res, Math.random() * 15));
  const holder = await claimLease(`race:${r}`, 60_000);
  if (holder) wins.push(r);
}

fs.writeFileSync(outFile, JSON.stringify(wins));
