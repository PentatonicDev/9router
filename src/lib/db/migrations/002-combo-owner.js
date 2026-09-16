// A combo name is unique per owner, not globally: two dashboard users may each
// own a combo called "fast". The old table declared `name TEXT UNIQUE`, and
// SQLite cannot drop a column-level constraint — the table has to be rebuilt.
export default {
  version: 2,
  name: "combo-owner",
  up(db) {
    const columns = db.all(`PRAGMA table_info(combos)`);
    if (!columns.length) return; // fresh DB: schema.js already creates the final shape

    const hasOwner = columns.some((c) => c.name === "owner");
    const ownerExpr = hasOwner ? "owner" : "NULL";

    db.exec(`CREATE TABLE IF NOT EXISTS combos_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT,
      models TEXT NOT NULL,
      owner TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    db.exec(`INSERT OR IGNORE INTO combos_new(id, name, kind, models, owner, createdAt, updatedAt)
             SELECT id, name, kind, models, ${ownerExpr}, createdAt, updatedAt FROM combos`);
    db.exec(`DROP TABLE combos`);
    db.exec(`ALTER TABLE combos_new RENAME TO combos`);
  },
};
