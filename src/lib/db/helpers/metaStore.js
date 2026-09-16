import { getDb } from "../kysely.js";

export async function getMeta(key, fallback = null) {
  const db = await getDb();
  const row = await db.selectFrom("_meta").select("value").where("key", "=", key).executeTakeFirst();
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await getDb();
  const v = String(value);
  await db.insertInto("_meta").values({ key, value: v })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: v }))
    .execute();
}

// Sync versions for use during migration (adapter passed directly)
export function getMetaSync(adapter, key, fallback = null) {
  const row = adapter.get(`SELECT value FROM _meta WHERE key = ?`, [key]);
  return row ? row.value : fallback;
}

export function setMetaSync(adapter, key, value) {
  adapter.run(`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
}
