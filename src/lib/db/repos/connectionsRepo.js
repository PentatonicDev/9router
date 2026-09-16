import { v4 as uuidv4 } from "uuid";
import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeOwnerInput, resolveDefaultOwner } from "@/lib/auth/resourceScope";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";
const MODEL_LOCK_META_PREFIX = "modelLockMeta_";

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX) || key.startsWith(MODEL_LOCK_META_PREFIX)) normalized[key] = null;
  }

  return normalized;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    owner: row.owner ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, owner, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    owner: owner ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

async function upsert(db, c) {
  const r = connToRow(c);
  await db.insertInto("providerConnections").values(r)
    .onConflict((oc) => oc.column("id").doUpdateSet({
      provider: r.provider, authType: r.authType, name: r.name, email: r.email,
      priority: r.priority, isActive: r.isActive, owner: r.owner,
      data: r.data, updatedAt: r.updatedAt,
    }))
    .execute();
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

export async function getProviderConnections(filter = {}) {
  const db = await getDb();
  let q = db.selectFrom("providerConnections").selectAll();
  if (filter.provider) q = q.where("provider", "=", filter.provider);
  if (filter.isActive !== undefined) q = q.where("isActive", "=", filter.isActive ? 1 : 0);
  // Shared accounts (owner IS NULL) stay in everyone's pool.
  if (filter.owner !== undefined) {
    q = q.where((eb) => eb.or([eb("owner", "is", null), eb("owner", "=", filter.owner)]));
  }
  const list = (await q.execute()).map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getDb();
  const row = await db.selectFrom("providerConnections").selectAll().where("id", "=", id).executeTakeFirst();
  return rowToConn(row);
}

// Internal reorder — must be called INSIDE a transaction
async function reorderInTx(db, providerId) {
  const list = (await db.selectFrom("providerConnections").selectAll()
    .where("provider", "=", providerId).execute()).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  for (const [i, c] of list.entries()) {
    await db.updateTable("providerConnections").set({ priority: i + 1 }).where("id", "=", c.id).execute();
  }
}

export async function createProviderConnection(data) {
  const db = await getDb();
  const now = new Date().toISOString();
  // Resolved here rather than at the ~23 call sites that create connections
  // (OAuth flows, bulk imports): a new one would otherwise be world-visible.
  const owner = data.owner === undefined ? await resolveDefaultOwner() : normalizeOwnerInput(data.owner);
  let result;

  await db.transaction().execute(async (trx) => {
    const all = (await trx.selectFrom("providerConnections").selectAll()
      .where("provider", "=", data.provider).execute()).map(rowToConn);

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      const normalized = resetHealthStateOnActivation(existing, data);
      // Re-login / re-import must not silently reassign an existing account.
      const merged = { ...existing, ...normalized, owner: existing.owner ?? null, updatedAt: now };
      await upsert(trx, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${all.length + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      owner,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    await upsert(trx, conn);
    await reorderInTx(trx, data.provider);
    result = conn;
  });

  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  const db = await getDb();
  let result;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("providerConnections").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const normalized = resetHealthStateOnActivation(existing, data);
    const merged = { ...existing, ...normalized, updatedAt: new Date().toISOString() };
    await upsert(trx, merged);
    const ownerChanged = data.owner !== undefined && (merged.owner ?? null) !== (existing.owner ?? null);
    if (ownerChanged) await unbindUnreachableInTx(trx, id, merged.owner ?? null);
    if (data.priority !== undefined) await reorderInTx(trx, existing.provider);
    result = merged;
  });
  return result;
}

// A deleted account must not linger in apiKeys.allowedConnectionIds, or the key
// page lists a phantom binding and the quota filter counts an account that is
// gone. Emptying a key's list returns it to unrestricted, per the documented
// "no bindings = every account" rule.
// Must be called INSIDE a transaction.
async function unbindConnectionsInTx(db, ids) {
  if (!ids.length) return;
  const removed = new Set(ids);
  const rows = await db.selectFrom("apiKeys").select(["id", "allowedConnectionIds"])
    .where("allowedConnectionIds", "is not", null).execute();
  for (const row of rows) {
    const current = parseJson(row.allowedConnectionIds, null);
    if (!Array.isArray(current)) continue;
    const next = current.filter((connId) => !removed.has(connId));
    if (next.length === current.length) continue;
    await db.updateTable("apiKeys")
      .set({ allowedConnectionIds: next.length ? stringifyJson(next) : null })
      .where("id", "=", row.id).execute();
  }
}

// An account binding must not outlive the visibility that justified it: after an
// owner change, a key whose owner can no longer see the account keeps routing to
// it, since the binding list is consulted before ownership at request time.
// Must be called INSIDE a transaction.
async function unbindUnreachableInTx(db, connectionId, owner) {
  const rows = await db.selectFrom("apiKeys").select(["id", "owner", "allowedConnectionIds"])
    .where("allowedConnectionIds", "is not", null).execute();
  for (const row of rows) {
    const current = parseJson(row.allowedConnectionIds, null);
    if (!Array.isArray(current) || !current.includes(connectionId)) continue;
    const keyOwner = row.owner ?? null;
    // Shared accounts stay reachable by everyone; an admin-owned key reaches
    // only admin-owned and shared accounts, and a user's key only their own.
    if (owner === null || keyOwner === owner) continue;
    const next = current.filter((id) => id !== connectionId);
    await db.updateTable("apiKeys")
      .set({ allowedConnectionIds: next.length ? stringifyJson(next) : null })
      .where("id", "=", row.id).execute();
  }
}

export async function deleteProviderConnection(id) {
  const db = await getDb();
  let ok = false;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("providerConnections").select("provider").where("id", "=", id).executeTakeFirst();
    if (!row) return;
    await trx.deleteFrom("providerConnections").where("id", "=", id).execute();
    await unbindConnectionsInTx(trx, [id]);
    await reorderInTx(trx, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getDb();
  let deleted = 0;
  await db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom("providerConnections").select("id").where("provider", "=", providerId).execute();
    if (!rows.length) return;
    await trx.deleteFrom("providerConnections").where("provider", "=", providerId).execute();
    await unbindConnectionsInTx(trx, rows.map((r) => r.id));
    deleted = rows.length;
  });
  return deleted;
}

export async function reorderProviderConnections(providerId) {
  const db = await getDb();
  await db.transaction().execute(async (trx) => reorderInTx(trx, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getDb();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  await db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom("providerConnections").selectAll().execute();
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) await upsert(trx, conn);
    }
  });
  return cleaned;
}
