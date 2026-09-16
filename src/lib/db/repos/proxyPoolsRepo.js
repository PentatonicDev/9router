import { v4 as uuidv4 } from "uuid";
import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

async function upsert(db, p) {
  const r = poolToRow(p);
  await db.insertInto("proxyPools").values(r)
    .onConflict((oc) => oc.column("id").doUpdateSet({
      isActive: r.isActive, testStatus: r.testStatus, data: r.data, updatedAt: r.updatedAt,
    }))
    .execute();
}

export async function getProxyPools(filter = {}) {
  const db = await getDb();
  let q = db.selectFrom("proxyPools").selectAll();
  if (filter.isActive !== undefined) q = q.where("isActive", "=", filter.isActive ? 1 : 0);
  if (filter.testStatus) q = q.where("testStatus", "=", filter.testStatus);
  const list = (await q.execute()).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getDb();
  return rowToPool(await db.selectFrom("proxyPools").selectAll().where("id", "=", id).executeTakeFirst());
}

export async function createProxyPool(data) {
  const db = await getDb();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  await upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getDb();
  let result = null;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("proxyPools").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    await upsert(trx, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getDb();
  let removed = null;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("proxyPools").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return;
    removed = rowToPool(row);
    await trx.deleteFrom("proxyPools").where("id", "=", id).execute();
  });
  return removed;
}
