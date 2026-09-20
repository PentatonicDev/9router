import { getDb } from "../kysely.js";
import { isDistributed } from "../mode.js";
import { normalizeConnectionBudgets, getApiKeyConnectionBudgets as getRawConnectionBudgets } from "./apiKeysRepo.js";

const BUDGET_CACHE_TTL_MS = 5000;
export const TOTAL_PERIOD_KEY = "total";

export function monthKeyUTC(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function periodKeyFor(period, at) {
  return period === "total" ? TOTAL_PERIOD_KEY : monthKeyUTC(at);
}

const budgetCache = new Map(); // apiKey -> { at, budgets }

/**
 * Connection→budget map for a key: apiKeysRepo.js's raw read, re-validated
 * through its own normalizeConnectionBudgets (defensive against stale rows
 * written before validation existed) and cached briefly so the hot request
 * path in auth.js doesn't add a DB round trip per call.
 */
export async function getApiKeyConnectionBudgets(key) {
  if (!key) return {};
  const cached = budgetCache.get(key);
  if (cached && Date.now() - cached.at < BUDGET_CACHE_TTL_MS) return cached.budgets;
  const raw = await getRawConnectionBudgets(key);
  const budgets = normalizeConnectionBudgets(raw) || {};
  budgetCache.set(key, { at: Date.now(), budgets });
  return budgets;
}

export function _clearBudgetCacheForTests() {
  budgetCache.clear();
}

const warnedOnce = new Set();

/**
 * Connections in `budgets` whose spend has reached its cap, per the ledger.
 * Also fires `onWarn(connId, spent, limitUsd)` once per key×connection×period
 * the first time spend crosses 80% — the period key in the dedup set means a
 * month rollover naturally re-arms the warning.
 */
export async function getExhaustedConnectionIds(apiKey, budgets, onWarn = null) {
  const exhausted = new Set();
  const connIds = Object.keys(budgets);
  if (!connIds.length) return exhausted;

  const db = await getDb();
  const month = monthKeyUTC();
  const rows = await db.selectFrom("spendLedger").select(["connectionId", "periodKey", "costUsd"])
    .where("apiKey", "=", apiKey)
    .where("connectionId", "in", connIds)
    .where("periodKey", "in", [TOTAL_PERIOD_KEY, month])
    .execute();

  const spentByConn = new Map();
  for (const row of rows) {
    const budget = budgets[row.connectionId];
    if (!budget || row.periodKey !== periodKeyFor(budget.period, new Date())) continue;
    spentByConn.set(row.connectionId, Number(row.costUsd || 0));
  }

  for (const [connId, budget] of Object.entries(budgets)) {
    const spent = spentByConn.get(connId) || 0;
    if (spent >= budget.limitUsd) {
      exhausted.add(connId);
      continue;
    }
    if (spent >= budget.limitUsd * 0.8 && onWarn) {
      const dedupeKey = `${apiKey}|${connId}|${periodKeyFor(budget.period, new Date())}`;
      if (!warnedOnce.has(dedupeKey)) {
        warnedOnce.add(dedupeKey);
        onWarn(connId, spent, budget.limitUsd);
      }
    }
  }
  return exhausted;
}

async function upsertLedgerRow(trx, { apiKey, connectionId, periodKey, cost, updatedAt }) {
  await trx.insertInto("spendLedger").values({ apiKey, connectionId, periodKey, costUsd: 0, updatedAt })
    .onConflict((oc) => oc.columns(["apiKey", "connectionId", "periodKey"]).doNothing())
    .execute();
  // Same seed-then-lock pattern as usageDaily/_meta in usageRepo.js: without
  // the lock, two concurrent requests on the same period read the same
  // costUsd and the later commit clobbers the other's addition (lost update
  // under Postgres READ COMMITTED). SQLite serializes writers within one
  // process and has no FOR UPDATE syntax.
  let q = trx.selectFrom("spendLedger").select("costUsd")
    .where("apiKey", "=", apiKey).where("connectionId", "=", connectionId).where("periodKey", "=", periodKey);
  if (isDistributed()) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  const newCost = Number(row?.costUsd || 0) + cost;
  await trx.updateTable("spendLedger").set({ costUsd: newCost, updatedAt })
    .where("apiKey", "=", apiKey).where("connectionId", "=", connectionId).where("periodKey", "=", periodKey)
    .execute();
}

/**
 * Records `cost` against both the lifetime ("total") and current-month ledger
 * rows for (apiKey, connectionId). Must run inside the same transaction as
 * the rest of saveRequestUsage's writes, and inside its dedup guard, or a
 * retried request double-charges the ledger.
 */
export async function recordSpend(trx, { apiKey, connectionId, cost, timestamp }) {
  if (!apiKey || !connectionId || !(cost > 0)) return;
  const at = timestamp ? new Date(timestamp) : new Date();
  const updatedAt = at.toISOString();
  await upsertLedgerRow(trx, { apiKey, connectionId, periodKey: TOTAL_PERIOD_KEY, cost, updatedAt });
  await upsertLedgerRow(trx, { apiKey, connectionId, periodKey: monthKeyUTC(at), cost, updatedAt });
}
