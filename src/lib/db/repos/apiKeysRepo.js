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

export async function createApiKey(name, machineId, tags = null, owner = undefined) {
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
    allowedConnectionIds: null,
    tags: normalizeTags(tags) || [],
    owner: owner === undefined ? await resolveDefaultOwner() : normalizeOwnerInput(owner),
    createdAt: new Date().toISOString(),
  };
  await db.insertInto("apiKeys").values({
    id: apiKey.id, key: apiKey.key, name: apiKey.name, machineId: apiKey.machineId,
    isActive: 1, allowedConnectionIds: null,
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
    if (data.owner !== undefined && (merged.owner ?? null) !== (previous.owner ?? null)) {
      merged.allowedConnectionIds = await reachableConnectionIds(trx, merged.allowedConnectionIds, merged.owner ?? null);
    }
    const tags = normalizeTags(merged.tags);
    merged.tags = tags || [];
    await trx.updateTable("apiKeys").set({
      key: merged.key, name: merged.name, machineId: merged.machineId,
      isActive: merged.isActive ? 1 : 0,
      allowedConnectionIds: merged.allowedConnectionIds ? stringifyJson(merged.allowedConnectionIds) : null,
      tags: tags ? stringifyJson(tags) : null,
      owner: merged.owner ?? null,
    }).where("id", "=", id).execute();
    result = merged;
  });
  return result;
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
