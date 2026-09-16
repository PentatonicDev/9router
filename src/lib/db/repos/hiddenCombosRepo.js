import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// A user may hide a shared combo to free its name for one of their own. Stored
// per user in kv rather than on the combo row, which is global and not theirs
// to edit. Hiding is by name: it is the name that has to be freed.
const SCOPE = "hiddenGlobalCombos";

export async function getHiddenComboNames(owner) {
  if (!owner) return [];
  const db = await getDb();
  const row = await db.selectFrom("kv").select("value")
    .where("scope", "=", SCOPE).where("key", "=", owner).executeTakeFirst();
  return row ? (parseJson(row.value, []) || []) : [];
}

export async function hideGlobalCombo(owner, name) {
  if (!owner || !name) return;
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("kv").select("value")
      .where("scope", "=", SCOPE).where("key", "=", owner).executeTakeFirst();
    const current = row ? (parseJson(row.value, []) || []) : [];
    if (current.includes(name)) return;
    const value = stringifyJson([...current, name]);
    await trx.insertInto("kv").values({ scope: SCOPE, key: owner, value })
      .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
      .execute();
  });
}

/**
 * Un-hide a shared combo. Refuses while the user still owns a combo of that
 * name, since both would then answer to it — they delete theirs first.
 * Returns false when blocked, so the caller can say why.
 */
export async function unhideGlobalCombo(owner, name) {
  if (!owner || !name) return false;
  const db = await getDb();
  let ok = false;
  await db.transaction().execute(async (trx) => {
    const clash = await trx.selectFrom("combos").select("id")
      .where("name", "=", name).where("owner", "=", owner).executeTakeFirst();
    if (clash) return;
    const row = await trx.selectFrom("kv").select("value")
      .where("scope", "=", SCOPE).where("key", "=", owner).executeTakeFirst();
    const next = (row ? (parseJson(row.value, []) || []) : []).filter((n) => n !== name);
    if (next.length) {
      const value = stringifyJson(next);
      await trx.insertInto("kv").values({ scope: SCOPE, key: owner, value })
        .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
        .execute();
    } else {
      await trx.deleteFrom("kv").where("scope", "=", SCOPE).where("key", "=", owner).execute();
    }
    ok = true;
  });
  return ok;
}
