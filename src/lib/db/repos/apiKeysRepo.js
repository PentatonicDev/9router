import { v4 as uuidv4 } from "uuid";
import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeOwnerInput, resolveDefaultOwner } from "@/lib/auth/resourceScope";

// An empty binding list means "no restriction": the key reaches every account.
// Callers rely on null (not []) to express that, so normalize both ways here.
function normalizeAllowed(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id) => typeof id === "string" && id.trim() !== "");
  return ids.length ? Array.from(new Set(ids)) : null;
}

const VALID_BUDGET_PERIODS = new Set(["month", "total"]);

// Structural validation for the spend-cap map; a connectionId no longer in
// allowedConnectionIds is dropped silently rather than rejected, the same
// "narrows itself" treatment reachableConnectionIds gives allowedConnectionIds
// on an owner change. allowedConnectionIds === null means unrestricted, so
// nothing is pruned on that account.
export function normalizeConnectionBudgets(value, allowedConnectionIds = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = Array.isArray(allowedConnectionIds) ? new Set(allowedConnectionIds) : null;
  const out = {};
  for (const [connId, budget] of Object.entries(value)) {
    if (typeof connId !== "string" || !connId.trim()) continue;
    if (allowed && !allowed.has(connId)) continue;
    if (!budget || typeof budget !== "object") continue;
    const limitUsd = Number(budget.limitUsd);
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) continue;
    if (!VALID_BUDGET_PERIODS.has(budget.period)) continue;
    out[connId] = { limitUsd, period: budget.period };
  }
  return Object.keys(out).length ? out : null;
}

const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 20;

// Tags are display labels: trimmed, de-duplicated case-insensitively (the
// first spelling wins) and capped so one key cannot bloat the row.
export function normalizeTags(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const tags = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const dedupeKey = tag.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags.length ? tags : null;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    // "usage" routes /v1 traffic; "admin" drives the dashboard REST API as its
    // owner and never routes (see resourceScope.js). Supersedes `management`.
    kind: row.kind === "admin" ? "admin" : "usage",
    connectionBudgets: parseJson(row.connectionBudgets, null) || {},
    allowedConnectionIds: normalizeAllowed(parseJson(row.allowedConnectionIds, null)),
    tags: normalizeTags(parseJson(row.tags, null)) || [],
    owner: row.owner ?? null,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getDb();
  const rows = await db.selectFrom("apiKeys").selectAll().orderBy("createdAt", "asc").execute();
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").selectAll().where("id", "=", id).executeTakeFirst();
  return rowToKey(row);
}

export async function createApiKey(name, machineId, tags = null, owner = undefined, kind = "usage") {
  if (!machineId) throw new Error("machineId is required");
  const db = await getDb();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    kind: kind === "admin" ? "admin" : "usage",
    connectionBudgets: {},
    allowedConnectionIds: null,
    tags: normalizeTags(tags) || [],
    owner: owner === undefined ? await resolveDefaultOwner() : normalizeOwnerInput(owner),
    createdAt: new Date().toISOString(),
  };
  await db.insertInto("apiKeys").values({
    id: apiKey.id, key: apiKey.key, name: apiKey.name, machineId: apiKey.machineId,
    isActive: 1, kind: apiKey.kind, connectionBudgets: null, allowedConnectionIds: null,
    tags: apiKey.tags.length ? stringifyJson(apiKey.tags) : null,
    owner: apiKey.owner, createdAt: apiKey.createdAt,
  }).execute();
  return apiKey;
}

// Bindings must not outlive the visibility that justified them: a key handed to
// another owner keeps routing to accounts that owner cannot see, because the
// binding list is consulted before ownership at request time. Dropping every
// binding would silently widen the key to all accounts ("no bindings = every
// account"), so only the now-unreachable ones go.
async function reachableConnectionIds(db, ids, owner) {
  if (!ids?.length) return null;
  const rows = await db.selectFrom("providerConnections").select(["id", "owner"])
    .where("id", "in", ids).execute();
  const ownerById = new Map(rows.map((r) => [r.id, r.owner ?? null]));
  const kept = ids.filter((connId) => {
    if (!ownerById.has(connId)) return false;
    const connOwner = ownerById.get(connId);
    return connOwner === null || connOwner === owner;
  });
  return kept.length ? kept : null;
}

export async function updateApiKey(id, data) {
  const db = await getDb();
  let result = null;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("apiKeys").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return;
    const previous = rowToKey(row);
    const merged = { ...previous, ...data };
    merged.allowedConnectionIds = normalizeAllowed(merged.allowedConnectionIds);
    // Defaults to allowedConnectionIds itself: null there genuinely means
    // unrestricted when no owner change happened, so nothing is pruned.
    let reachableForBudgets = merged.allowedConnectionIds;
    if (data.owner !== undefined && (merged.owner ?? null) !== (previous.owner ?? null)) {
      const kept = await reachableConnectionIds(trx, merged.allowedConnectionIds, merged.owner ?? null);
      merged.allowedConnectionIds = kept;
      // reachableConnectionIds collapses "every binding fell out of reach" to
      // null too (same "empty = unrestricted" convention allowedConnectionIds
      // itself uses) — but a budget must not read that as "anything goes" and
      // survive on a connection the new owner cannot see. [] (not null) here
      // tells normalizeConnectionBudgets below to prune everything instead.
      reachableForBudgets = kept ?? [];
    }
    // Re-run after any allowedConnectionIds pruning above, so a budget on a
    // connection the key can no longer reach doesn't survive an owner change.
    merged.connectionBudgets = normalizeConnectionBudgets(merged.connectionBudgets, reachableForBudgets);
    const tags = normalizeTags(merged.tags);
    merged.tags = tags || [];
    merged.kind = merged.kind === "admin" ? "admin" : "usage";
    await trx.updateTable("apiKeys").set({
      key: merged.key, name: merged.name, machineId: merged.machineId,
      isActive: merged.isActive ? 1 : 0,
      kind: merged.kind,
      connectionBudgets: merged.connectionBudgets ? stringifyJson(merged.connectionBudgets) : null,
      allowedConnectionIds: merged.allowedConnectionIds ? stringifyJson(merged.allowedConnectionIds) : null,
      tags: tags ? stringifyJson(tags) : null,
      owner: merged.owner ?? null,
    }).where("id", "=", id).execute();
    result = merged;
  });
  return result;
}

// The one admin key an owner may hold (idx_ak_admin_owner is the DB-level
// backstop for this). excludeId lets a PUT re-check without self-conflicting
// when editing/rotating that very key.
export async function getAdminKeyByOwner(owner, excludeId = null) {
  if (!owner) return null;
  const db = await getDb();
  let query = db.selectFrom("apiKeys").selectAll().where("owner", "=", owner).where("kind", "=", "admin");
  if (excludeId) query = query.where("id", "!=", excludeId);
  return rowToKey(await query.executeTakeFirst());
}

// True when `error` is idx_ak_admin_owner rejecting a write, on any of the
// four SQLite drivers (better-sqlite3, node:sqlite, bun:sqlite, sql.js all
// throw "UNIQUE constraint failed: apiKeys.owner", verified against each) or
// Postgres (code 23505, constraint name). Lets a route convert the DB-level
// rejection of the route's own TOCTOU race (check-then-insert on the same
// owner from two concurrent requests) into 409 instead of a generic 500 —
// distinguished from the table's other UNIQUE column (`key`) by column/index
// name, not just "some constraint failed".
export function isAdminOwnerConflict(error) {
  if (error?.code === "23505") return error.constraint === "idx_ak_admin_owner";
  return /UNIQUE constraint failed: apiKeys\.owner/.test(error?.message || "");
}

// SPEND's per-connection cap read, kept as its own lightweight query rather
// than folded into getApiKeyRoutingContext so the routing hot path doesn't
// widen its row for callers that never consult budgets.
export async function getApiKeyConnectionBudgets(key) {
  if (!key) return {};
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("connectionBudgets").where("key", "=", key).executeTakeFirst();
  return parseJson(row?.connectionBudgets, null) || {};
}

export async function deleteApiKey(id) {
  const db = await getDb();
  const res = await db.deleteFrom("apiKeys").where("id", "=", id).executeTakeFirst();
  return Number(res?.numDeletedRows ?? 0) > 0;
}

/**
 * Connection ids this key is bound to, or null when it is unrestricted.
 * An unknown key is also unrestricted — key *validity* is a separate check
 * (validateApiKey), gated by settings.requireApiKey.
 */
export async function getApiKeyAllowedConnectionIds(key) {
  if (!key) return null;
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("allowedConnectionIds").where("key", "=", key).executeTakeFirst();
  if (!row) return null;
  return normalizeAllowed(parseJson(row.allowedConnectionIds, null));
}

// Everything the router needs from an API key, in one read. In distributed mode
// each call is a Postgres round trip; keeping validity, ownership, bindings and
// label together avoids re-reading the same row four times before dispatch.
export async function getApiKeyRoutingContext(key) {
  if (!key) return { valid: false, owner: null, name: null, kind: "usage", allowedConnectionIds: null };
  const db = await getDb();
  const row = await db.selectFrom("apiKeys")
    .select(["isActive", "owner", "name", "kind", "allowedConnectionIds"])
    .where("key", "=", key).executeTakeFirst();
  return {
    valid: row ? row.isActive === 1 || row.isActive === true : false,
    owner: row?.owner ?? null,
    name: row?.name ?? null,
    kind: row?.kind === "admin" ? "admin" : "usage",
    allowedConnectionIds: normalizeAllowed(parseJson(row?.allowedConnectionIds, null)),
  };
}

/**
 * The owner of a key, as stored. Used by the router, where there is no session:
 * the key itself carries the identity that caps which accounts it may reach.
 * An unknown key has no owner, matching validateApiKey being a separate check.
 */
/**
 * Identity of a key by its value: owner for scoping, name for labelling.
 * One lookup, since the router needs both on every request.
 */
export async function getApiKeyIdentity(key) {
  if (!key) return { owner: null, name: null };
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select(["owner", "name"]).where("key", "=", key).executeTakeFirst();
  return { owner: row?.owner ?? null, name: row?.name ?? null };
}

export async function getApiKeyOwner(key) {
  if (!key) return null;
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("owner").where("key", "=", key).executeTakeFirst();
  return row?.owner ?? null;
}

export async function validateApiKey(key) {
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("isActive").where("key", "=", key).executeTakeFirst();
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
