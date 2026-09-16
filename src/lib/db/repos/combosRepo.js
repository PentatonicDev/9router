import { v4 as uuidv4 } from "uuid";
import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeOwnerInput, resolveDefaultOwner } from "@/lib/auth/resourceScope";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    owner: row.owner ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getDb();
  const rows = await db.selectFrom("combos").selectAll().orderBy("createdAt", "asc").execute();
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getDb();
  const row = await db.selectFrom("combos").selectAll().where("id", "=", id).executeTakeFirst();
  return rowToCombo(row);
}

/**
 * Resolve a combo by name. With an owner given, that user's own combo wins over
 * the shared one of the same name — which is what lets two users each keep a
 * combo called "fast". Without an owner, only shared combos resolve.
 */
export async function getComboByName(name, owner = undefined) {
  const db = await getDb();
  const shared = () => db.selectFrom("combos").selectAll()
    .where("name", "=", name).where("owner", "is", null).executeTakeFirst();

  if (owner === undefined) {
    return rowToCombo(await db.selectFrom("combos").selectAll().where("name", "=", name).executeTakeFirst());
  }
  if (owner === null) return rowToCombo(await shared());

  const own = await db.selectFrom("combos").selectAll()
    .where("name", "=", name).where("owner", "=", owner).executeTakeFirst();
  if (own) return rowToCombo(own);

  // A shared combo the user hid no longer answers for them.
  const hidden = await db.selectFrom("kv").select("value")
    .where("scope", "=", "hiddenGlobalCombos").where("key", "=", owner).executeTakeFirst();
  if ((parseJson(hidden?.value, []) || []).includes(name)) return null;

  return rowToCombo(await shared());
}

export async function createCombo(data) {
  const db = await getDb();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    owner: data.owner === undefined ? await resolveDefaultOwner() : normalizeOwnerInput(data.owner),
    createdAt: now,
    updatedAt: now,
  };
  await db.insertInto("combos").values({
    id: combo.id, name: combo.name, kind: combo.kind,
    models: stringifyJson(combo.models), owner: combo.owner,
    createdAt: combo.createdAt, updatedAt: combo.updatedAt,
  }).execute();
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getDb();
  let result = null;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("combos").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    await trx.updateTable("combos").set({
      name: merged.name, kind: merged.kind,
      models: stringifyJson(merged.models || []),
      owner: merged.owner ?? null, updatedAt: merged.updatedAt,
    }).where("id", "=", id).execute();
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getDb();
  const res = await db.deleteFrom("combos").where("id", "=", id).executeTakeFirst();
  return Number(res?.numDeletedRows ?? 0) > 0;
}
