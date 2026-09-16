import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "./jsonCol.js";

export function makeKv(scope) {
  return {
    async get(key, fallback = null) {
      const db = await getDb();
      const row = await db.selectFrom("kv").select("value")
        .where("scope", "=", scope).where("key", "=", key).executeTakeFirst();
      return row ? parseJson(row.value, fallback) : fallback;
    },
    async getAll() {
      const db = await getDb();
      const rows = await db.selectFrom("kv").select(["key", "value"]).where("scope", "=", scope).execute();
      const out = {};
      for (const r of rows) out[r.key] = parseJson(r.value);
      return out;
    },
    async set(key, value) {
      const db = await getDb();
      const v = stringifyJson(value);
      await db.insertInto("kv").values({ scope, key, value: v })
        .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value: v }))
        .execute();
    },
    async setMany(obj) {
      const db = await getDb();
      await db.transaction().execute(async (trx) => {
        for (const [k, v] of Object.entries(obj)) {
          const value = stringifyJson(v);
          await trx.insertInto("kv").values({ scope, key: k, value })
            .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
            .execute();
        }
      });
    },
    async remove(key) {
      const db = await getDb();
      await db.deleteFrom("kv").where("scope", "=", scope).where("key", "=", key).execute();
    },
    async clear() {
      const db = await getDb();
      await db.deleteFrom("kv").where("scope", "=", scope).execute();
    },
  };
}
