import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "disabledModels";

export async function getDisabledModels() {
  const db = await getDb();
  const rows = await db.selectFrom("kv").select(["key", "value"]).where("scope", "=", SCOPE).execute();
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  return out;
}

export async function getDisabledByProvider(providerAlias) {
  const db = await getDb();
  const row = await db.selectFrom("kv").select("value")
    .where("scope", "=", SCOPE).where("key", "=", providerAlias).executeTakeFirst();
  return row ? (parseJson(row.value, []) || []) : [];
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("kv").select("value")
      .where("scope", "=", SCOPE).where("key", "=", providerAlias).executeTakeFirst();
    const current = row ? (parseJson(row.value, []) || []) : [];
    const value = stringifyJson([...new Set([...current, ...ids])]);
    await trx.insertInto("kv").values({ scope: SCOPE, key: providerAlias, value })
      .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
      .execute();
  });
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    const del = () => trx.deleteFrom("kv").where("scope", "=", SCOPE).where("key", "=", providerAlias).execute();
    if (!Array.isArray(ids) || ids.length === 0) { await del(); return; }
    const row = await trx.selectFrom("kv").select("value")
      .where("scope", "=", SCOPE).where("key", "=", providerAlias).executeTakeFirst();
    const current = row ? (parseJson(row.value, []) || []) : [];
    const removeSet = new Set(ids);
    const next = current.filter((id) => !removeSet.has(id));
    if (next.length === 0) { await del(); return; }
    const value = stringifyJson(next);
    await trx.insertInto("kv").values({ scope: SCOPE, key: providerAlias, value })
      .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
      .execute();
  });
}
