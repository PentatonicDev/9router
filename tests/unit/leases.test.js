// Covers claim/renew/release/withLease semantics and the fail-open path when
// the jobLeases table is unavailable (see src/lib/db/leases.js header).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let leases;
let closeDb;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-leases-"));
  process.env.DATA_DIR = tempDir;
  leases = await import("@/lib/db/leases.js");
  const kysely = await import("@/lib/db/kysely.js");
  closeDb = kysely.closeDb;
  // Force schema creation before the tests run.
  await kysely.getDb();
});

afterAll(async () => {
  await closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("job leases", () => {
  it("single claim wins", async () => {
    const holder = await leases.claimLease("solo", 60_000);
    expect(typeof holder).toBe("string");
    await leases.releaseLease("solo", holder);
  });

  it("second claim for the same id loses while the first is live", async () => {
    const first = await leases.claimLease("dup", 60_000);
    expect(first).toBeTruthy();
    const second = await leases.claimLease("dup", 60_000);
    expect(second).toBeNull();
    await leases.releaseLease("dup", first);
  });

  it("wins again after the previous lease expires", async () => {
    const first = await leases.claimLease("expiring", 50);
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 80));
    const second = await leases.claimLease("expiring", 60_000);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await leases.releaseLease("expiring", second);
  });

  it("renew extends a lease this holder owns", async () => {
    const holder = await leases.claimLease("renewed", 50);
    expect(holder).toBeTruthy();
    const ok = await leases.renewLease("renewed", holder, 60_000);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    // Still live because it was renewed with a long TTL — a competing claim loses.
    const competitor = await leases.claimLease("renewed", 60_000);
    expect(competitor).toBeNull();
    await leases.releaseLease("renewed", holder);
  });

  it("renew fails for a holder that no longer owns the lease", async () => {
    const holder = await leases.claimLease("renew-mismatch", 60_000);
    const ok = await leases.renewLease("renew-mismatch", "someone-else", 60_000);
    expect(ok).toBe(false);
    await leases.releaseLease("renew-mismatch", holder);
  });

  it("release frees the lease for the next claimant", async () => {
    const holder = await leases.claimLease("released", 60_000);
    await leases.releaseLease("released", holder);
    const next = await leases.claimLease("released", 60_000);
    expect(next).toBeTruthy();
    await leases.releaseLease("released", next);
  });

  it("release does nothing for a holder that no longer owns the lease", async () => {
    const holder = await leases.claimLease("release-mismatch", 60_000);
    expect(holder).toBeTruthy();
    await leases.releaseLease("release-mismatch", "someone-else");
    // The real lease must still be live — a competing claim loses.
    const competitor = await leases.claimLease("release-mismatch", 60_000);
    expect(competitor).toBeNull();
    await leases.releaseLease("release-mismatch", holder);
  });

  it("withLease runs fn exactly once and releases afterward", async () => {
    let calls = 0;
    const { ran, result } = await leases.withLease("with-lease-ok", 60_000, async ({ holder }) => {
      calls += 1;
      expect(typeof holder).toBe("string");
      return "done";
    });
    expect(ran).toBe(true);
    expect(result).toBe("done");
    expect(calls).toBe(1);

    // Lease was released, so a fresh claim succeeds right away.
    const next = await leases.claimLease("with-lease-ok", 60_000);
    expect(next).toBeTruthy();
    await leases.releaseLease("with-lease-ok", next);
  });

  it("withLease still releases when fn throws", async () => {
    await expect(
      leases.withLease("with-lease-throws", 60_000, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const next = await leases.claimLease("with-lease-throws", 60_000);
    expect(next).toBeTruthy();
    await leases.releaseLease("with-lease-throws", next);
  });

  it("withLease skips and calls onSkip when the lease is already held", async () => {
    const holder = await leases.claimLease("with-lease-skip", 60_000);
    let skipped = false;
    const { ran } = await leases.withLease(
      "with-lease-skip",
      60_000,
      async () => {
        throw new Error("must not run");
      },
      { onSkip: () => { skipped = true; } }
    );
    expect(ran).toBe(false);
    expect(skipped).toBe(true);
    await leases.releaseLease("with-lease-skip", holder);
  });

  it("fails open (claim wins) when the jobLeases table is missing", async () => {
    const kysely = await import("@/lib/db/kysely.js");
    const db = await kysely.getDb();
    await db.schema.dropTable("jobLeases").execute();

    const holder = await leases.claimLease("no-table", 60_000);
    expect(typeof holder).toBe("string");

    const { ran } = await leases.withLease("no-table-2", 60_000, async () => "ok");
    expect(ran).toBe(true);
  });
});
