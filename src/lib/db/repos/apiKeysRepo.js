import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

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
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, tags = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
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
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, allowedConnectionIds, tags, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, null,
     apiKey.tags.length ? stringifyJson(apiKey.tags) : null, apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    merged.allowedConnectionIds = normalizeAllowed(merged.allowedConnectionIds);
    const tags = normalizeTags(merged.tags);
    merged.tags = tags || [];
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, allowedConnectionIds = ?, tags = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
       merged.allowedConnectionIds ? stringifyJson(merged.allowedConnectionIds) : null,
       tags ? stringifyJson(tags) : null, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

/**
 * Connection ids this key is bound to, or null when it is unrestricted.
 * An unknown key is also unrestricted — key *validity* is a separate check
 * (validateApiKey), gated by settings.requireApiKey.
 */
export async function getApiKeyAllowedConnectionIds(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT allowedConnectionIds FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return null;
  return normalizeAllowed(parseJson(row.allowedConnectionIds, null));
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
