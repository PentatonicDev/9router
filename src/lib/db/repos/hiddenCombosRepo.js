import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// A user may hide a shared combo to free its name for one of their own. Stored
// per user in kv rather than on the combo row, which is global and not theirs
// to edit. Hiding is by name: it is the name that has to be freed.
const SCOPE = "hiddenGlobalCombos";

export async function getHiddenComboNames(owner) {
  if (!owner) return [];
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, owner]);
  return row ? (parseJson(row.value, []) || []) : [];
}

export async function hideGlobalCombo(owner, name) {
  if (!owner || !name) return;
  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, owner]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    if (current.includes(name)) return;
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, owner, stringifyJson([...current, name])]
    );
  });
}

/**
 * Un-hide a shared combo. Refuses while the user still owns a combo of that
 * name, since both would then answer to it — they delete theirs first.
 * Returns false when blocked, so the caller can say why.
 */
export async function unhideGlobalCombo(owner, name) {
  if (!owner || !name) return false;
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const clash = db.get(`SELECT id FROM combos WHERE name = ? AND owner = ?`, [name, owner]);
    if (clash) return;
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, owner]);
    const next = (row ? (parseJson(row.value, []) || []) : []).filter((n) => n !== name);
    if (next.length) {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, owner, stringifyJson(next)]
      );
    } else {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, owner]);
    }
    ok = true;
  });
  return ok;
}
