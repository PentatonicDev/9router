import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// A shared account belongs to the admin, so a user cannot edit or delete it —
// but they may take it out of their own routing. That choice is theirs alone,
// so it lives per user in kv rather than on the account row, which is global.
const SCOPE = "disabledSharedAccounts";

export async function getDisabledAccountIds(owner) {
  if (!owner) return [];
  const db = await getDb();
  const row = await db.selectFrom("kv").select("value")
    .where("scope", "=", SCOPE).where("key", "=", owner).executeTakeFirst();
  return parseJson(row?.value, []) || [];
}

export async function setAccountDisabled(owner, connectionId, disabled) {
  if (!owner || !connectionId) return [];
  const db = await getDb();
  let next = [];
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("kv").select("value")
      .where("scope", "=", SCOPE).where("key", "=", owner).executeTakeFirst();
    const current = parseJson(row?.value, []) || [];

    next = disabled
      ? (current.includes(connectionId) ? current : [...current, connectionId])
      : current.filter((id) => id !== connectionId);

    if (next.length) {
      const value = stringifyJson(next);
      await trx.insertInto("kv").values({ scope: SCOPE, key: owner, value })
        .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
        .execute();
    } else {
      await trx.deleteFrom("kv").where("scope", "=", SCOPE).where("key", "=", owner).execute();
    }
  });
  return next;
}
