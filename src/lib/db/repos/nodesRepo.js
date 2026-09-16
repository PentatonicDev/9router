import { v4 as uuidv4 } from "uuid";
import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

async function upsert(db, n) {
  const r = nodeToRow(n);
  await db.insertInto("providerNodes").values(r)
    .onConflict((oc) => oc.column("id").doUpdateSet({
      type: r.type, name: r.name, data: r.data, updatedAt: r.updatedAt,
    }))
    .execute();
}

export async function getProviderNodes(filter = {}) {
  const db = await getDb();
  let q = db.selectFrom("providerNodes").selectAll();
  if (filter.type) q = q.where("type", "=", filter.type);
  return (await q.execute()).map(rowToNode);
}

export async function getProviderNodeById(id) {
  const db = await getDb();
  return rowToNode(await db.selectFrom("providerNodes").selectAll().where("id", "=", id).executeTakeFirst());
}

export async function createProviderNode(data) {
  const db = await getDb();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };
  await upsert(db, node);
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getDb();
  let result = null;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("providerNodes").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return;
    const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString() };
    await upsert(trx, merged);
    result = merged;
  });
  return result;
}

export async function deleteProviderNode(id) {
  const db = await getDb();
  let removed = null;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("providerNodes").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return;
    removed = rowToNode(row);
    await trx.deleteFrom("providerNodes").where("id", "=", id).execute();
  });
  return removed;
}
