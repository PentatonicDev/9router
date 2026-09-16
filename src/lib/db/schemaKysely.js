// Schema creation through Kysely, so one declaration produces the right DDL on
// both SQLite and Postgres. The shapes stay the ones in schema.js — this only
// changes who writes the CREATE TABLE.
import { sql } from "kysely";
import { TABLES, INDEXES } from "./schema.js";
import { isDistributed } from "./mode.js";

// SQLite stores booleans as 0/1 and has no BIGSERIAL; Postgres has no
// AUTOINCREMENT. Column types are declared once here per dialect.
function columnType(def, pg) {
  const d = def.toUpperCase();
  if (d.includes("AUTOINCREMENT")) return pg ? "bigserial" : "integer";
  if (d.startsWith("REAL")) return pg ? "double precision" : "real";
  if (d.startsWith("INTEGER")) return "integer";
  return "text";
}

function applyModifiers(col, def, pg) {
  const d = def.toUpperCase();
  let c = col;
  if (d.includes("PRIMARY KEY")) c = c.primaryKey();
  if (d.includes("UNIQUE")) c = c.unique();
  if (d.includes("NOT NULL") && !d.includes("PRIMARY KEY")) c = c.notNull();
  const dflt = d.match(/DEFAULT\s+(-?\d+(?:\.\d+)?)/);
  if (dflt) c = c.defaultTo(Number(dflt[1]));
  return c;
}

export async function createSchema(db) {
  const pg = isDistributed();

  for (const [name, def] of Object.entries(TABLES)) {
    let builder = db.schema.createTable(name).ifNotExists();

    for (const [col, colDef] of Object.entries(def.columns)) {
      builder = builder.addColumn(col, columnType(colDef, pg), (c) => applyModifiers(c, colDef, pg));
    }

    // Composite primary keys are declared on the table, not the column.
    if (def.primaryKey) {
      const cols = def.primaryKey.replace(/PRIMARY\s+KEY\s*\(/i, "").replace(/\)\s*$/, "")
        .split(",").map((c) => c.trim()).filter(Boolean);
      if (cols.length) builder = builder.addPrimaryKeyConstraint(`pk_${name}`, cols);
    }

    await builder.execute();

  }

  await createIndexes(db, pg);
}

// Postgres folds unquoted identifiers to lower case, so a camelCase table name
// has to be quoted; Kysely does that per dialect, which raw DDL could not.
async function createIndexes(db, pg) {
  for (const idx of INDEXES) {
    try {
      if (idx.expression) {
        const cols = pg ? idx.expression.pg : idx.expression.sqlite;
        const table = pg ? `"${idx.table}"` : idx.table;
        const unique = idx.unique ? "UNIQUE " : "";
        await sql.raw(`CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON ${table}(${cols})`).execute(db);
        continue;
      }
      let b = db.schema.createIndex(idx.name).ifNotExists().on(idx.table);
      if (idx.unique) b = b.unique();
      b = idx.order === "desc"
        ? b.expression(sql.raw(idx.columns.map((c) => `"${c}" DESC`).join(", ")))
        : b.columns(idx.columns);
      await b.execute();
    } catch (e) {
      if (!/already exists/i.test(e.message || "")) {
        console.warn(`[DB][schema] index ${idx.name} skipped: ${e.message}`);
      }
    }
  }
}

/**
 * Add columns declared in TABLES that the live database is missing.
 * Mirrors the additive sync the SQLite path already had, so a deployment that
 * gains a column picks it up without a migration file.
 */
export async function syncColumns(db) {
  const pg = isDistributed();
  for (const [name, def] of Object.entries(TABLES)) {
    let existing;
    try {
      existing = new Set(await listColumns(db, name, pg));
    } catch {
      continue; // table not there yet; createSchema handles it
    }
    for (const [col, colDef] of Object.entries(def.columns)) {
      if (existing.has(col)) continue;
      // PRIMARY KEY / UNIQUE are create-time only, so the added column carries
      // just its type and default.
      const bare = colDef.replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "").replace(/UNIQUE/i, "").trim();
      try {
        await db.schema.alterTable(name)
          .addColumn(col, columnType(bare, pg), (c) => applyModifiers(c, bare, pg))
          .execute();
        console.log(`[DB][schema] +column ${name}.${col}`);
      } catch (e) {
        console.warn(`[DB][schema] add column ${name}.${col} failed: ${e.message}`);
      }
    }
  }
}

async function listColumns(db, table, pg) {
  if (pg) {
    const rows = await sql`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_name = ${table} AND table_schema = current_schema()
    `.execute(db);
    return rows.rows.map((r) => r.name);
  }
  const rows = await sql.raw(`PRAGMA table_info(${table})`).execute(db);
  return rows.rows.map((r) => r.name);
}
