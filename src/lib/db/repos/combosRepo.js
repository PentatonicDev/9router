import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
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
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

/**
 * Resolve a combo by name. With an owner given, that user's own combo wins over
 * the shared one of the same name — which is what lets two users each keep a
 * combo called "fast". Without an owner, only shared combos resolve.
 */
export async function getComboByName(name, owner = undefined) {
  const db = await getAdapter();
  if (owner === undefined) {
    const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
    return rowToCombo(row);
  }
  if (owner === null) return rowToCombo(db.get(`SELECT * FROM combos WHERE name = ? AND owner IS NULL`, [name]));

  const own = db.get(`SELECT * FROM combos WHERE name = ? AND owner = ?`, [name, owner]);
  if (own) return rowToCombo(own);

  // A shared combo the user hid no longer answers for them.
  const hidden = db.get(`SELECT value FROM kv WHERE scope = 'hiddenGlobalCombos' AND key = ?`, [owner]);
  if ((parseJson(hidden?.value, []) || []).includes(name)) return null;

  return rowToCombo(db.get(`SELECT * FROM combos WHERE name = ? AND owner IS NULL`, [name]));
}

export async function createCombo(data) {
  const db = await getAdapter();
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
  db.run(
    `INSERT INTO combos(id, name, kind, models, owner, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.owner, combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, owner = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.owner ?? null, merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
