// Cross-process/cross-instance mutex for background jobs, backed by the
// `jobLeases` table (schema.js) so it works the same over SQLite (single
// process) and Postgres (several instances sharing one database).
//
// Contract: the loser of a claim NEVER waits or blocks on the winner — it
// re-reads whatever state it needed, or simply defers to the next tick/request.
// The winner must re-read the row it is about to mutate rather than trusting
// an object it already held from before the claim, since a lease only proves
// ownership at the instant it was granted/renewed.
import crypto from "node:crypto";
import { getDb } from "./kysely.js";
import { getInstanceId } from "../instanceId.js";

// SQLite under real cross-process write contention (two processes hitting the
// same file at once — exactly what this module exists to arbitrate) throws
// "database is locked" / SQLITE_BUSY even with PRAGMA busy_timeout set; this
// is transient, not "the table/DB is unavailable", so it must be retried
// rather than treated as fail-open — verified with a two-OS-process race
// (tests/unit/leases-two-process.test.js): without this retry, both sides hit
// the busy error on the same round and fail-open lets them both "win".
// ponytail: worst case before fail-open kicks in is bounded by
// BUSY_RETRY_ATTEMPTS attempts, each of which can itself block up to
// PRAGMA busy_timeout (5000ms, schema.js) inside the SQLite driver before
// throwing — on top of the backoff below. That means "exactly one winner"
// degrades from a guarantee to a probability under sustained contention:
// a claim can block on the order of tens of seconds before either side
// concedes. If that ceiling ever matters to a caller, switch to a wall-clock
// deadline for the whole claim instead of a fixed attempt count.
const BUSY_RETRY_ATTEMPTS = 8;
const BUSY_RETRY_BASE_MS = 15;
const isTransientBusy = (e) => /database is locked|SQLITE_BUSY|deadlock/i.test(e?.message || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail-open logs on every failed claim by default, which floods logs during a
// real outage (a scheduler ticking on an interval hits this every tick). Warn
// at most once per id per window instead of suppressing it entirely, so the
// first occurrence is still visible.
const FAILOPEN_WARN_WINDOW_MS = 30_000;
const lastFailOpenWarnAt = new Map();
function warnFailOpenOnce(id, message) {
  const now = Date.now();
  const last = lastFailOpenWarnAt.get(id) || 0;
  if (now - last < FAILOPEN_WARN_WINDOW_MS) return;
  lastFailOpenWarnAt.set(id, now);
  console.warn(message);
}

/**
 * Try to become the sole holder of `id` for `ttlMs`.
 * Returns the winning holder string, or null if another lease is still live.
 *
 * Two-step claim: (a) seed the row via INSERT ... ON CONFLICT DO NOTHING with
 * this call as holder — a no-op if the row already exists; (b) UPDATE the row
 * to this call's holder/expiry, but only where it is already ours (the insert
 * above won) or the existing lease expired. The update touches exactly one row
 * iff we won: after a winning insert, the WHERE matches on holder = ours; a
 * concurrent loser's insert did nothing, so its own update finds a live lease
 * held by someone else and touches zero rows.
 *
 * Times are ISO strings from Date.now(), the same convention every scheduler
 * in this repo uses. This assumes clocks across instances are reasonably in
 * sync — under real clock skew a lease can look expired slightly early or
 * late on a different node than the one that set it.
 */
export async function claimLease(id, ttlMs, { holder } = {}) {
  const claimant = holder || `${getInstanceId()}:${crypto.randomUUID()}`;

  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    try {
      const db = await getDb();

      await db
        .insertInto("jobLeases")
        .values({ id, holder: claimant, expiresAt, updatedAt: nowIso })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();

      const res = await db
        .updateTable("jobLeases")
        .set({ holder: claimant, expiresAt, updatedAt: nowIso })
        .where("id", "=", id)
        .where((eb) => eb.or([eb("holder", "=", claimant), eb("expiresAt", "<=", nowIso)]))
        .executeTakeFirst();

      return Number(res?.numUpdatedRows ?? 0) === 1 ? claimant : null;
    } catch (e) {
      if (isTransientBusy(e) && attempt < BUSY_RETRY_ATTEMPTS) {
        await sleep(BUSY_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      // Fail-open: pre-lease behaviour was "everyone runs" (no coordination at
      // all), so a genuine outage (missing table, connection down, or busy
      // contention that never clears) must not stop background work.
      warnFailOpenOnce(id, `[DB][leases] claim "${id}" failed, failing open: ${e.message}`);
      return claimant;
    }
  }
}

/** Extend a lease this holder already owns. Returns whether it still owned it. */
export async function renewLease(id, holder, ttlMs) {
  const db = await getDb();
  const now = Date.now();
  const res = await db
    .updateTable("jobLeases")
    .set({ expiresAt: new Date(now + ttlMs).toISOString(), updatedAt: new Date(now).toISOString() })
    .where("id", "=", id)
    .where("holder", "=", holder)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) === 1;
}

/** Give up a lease this holder owns. Never throws. */
export async function releaseLease(id, holder) {
  try {
    const db = await getDb();
    await db.deleteFrom("jobLeases").where("id", "=", id).where("holder", "=", holder).execute();
  } catch (e) {
    console.warn(`[DB][leases] release "${id}" failed: ${e.message}`);
  }
}

/**
 * Run `fn` only if this call wins the lease on `id`; otherwise call `onSkip`
 * (if given) and return without running `fn`. `fn` receives the winning
 * holder and a `renew` callback for long-running work. The lease is always
 * released afterward, even if `fn` throws.
 */
export async function withLease(id, ttlMs, fn, { onSkip } = {}) {
  const holder = await claimLease(id, ttlMs);
  if (!holder) {
    await onSkip?.();
    return { ran: false };
  }
  try {
    const result = await fn({ holder, renew: () => renewLease(id, holder, ttlMs) });
    return { ran: true, result };
  } finally {
    await releaseLease(id, holder);
  }
}
