// One Kysely instance per process, over SQLite (local) or Postgres (distributed).
// The repos speak Kysely, so the same query code runs on both — no dialect
// translation in application code.
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { getAdapter } from "./driver.js";
import { getDatabaseUrl, isDistributed } from "./mode.js";

if (!global._kysely) global._kysely = { instance: null, initPromise: null, pool: null };
const state = global._kysely;

// Kysely's SQLite dialect drives a better-sqlite3-shaped object. Every adapter
// in the fallback chain already exposes prepared statements, so this wraps
// whichever one the driver picked rather than opening a second connection to
// the same file — two handles on one SQLite file invite lock contention.
function sqliteDatabaseFrom(adapter) {
  return {
    prepare(sql) {
      const isSelect = /^\s*(select|pragma|with)/i.test(sql);
      return {
        reader: isSelect,
        all: (params = []) => adapter.all(sql, normalize(params)),
        get: (params = []) => adapter.get(sql, normalize(params)),
        run: (params = []) => {
          const r = adapter.run(sql, normalize(params)) || {};
          return {
            changes: Number(r.changes ?? 0),
            lastInsertRowid: Number(r.lastInsertRowid ?? 0),
          };
        },
      };
    },
    exec: (sql) => adapter.exec(sql),
    close: () => {},
  };
}

function normalize(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

async function createPostgres() {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
    // Several instances share this database, so a modest per-instance pool
    // keeps the total connection count predictable.
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 10_000),
  });
  // Fail loudly at boot rather than on the first query of the first request.
  const probe = await pool.connect();
  probe.release();
  state.pool = pool;
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}

async function createSqlite() {
  // getAdapter() also runs the SQLite migration chain (versioned migrations,
  // additive sync, one-time legacy JSON import), so the local path keeps every
  // guarantee it had before Kysely sat on top of it.
  const adapter = await getAdapter();
  return new Kysely({ dialect: new SqliteDialect({ database: sqliteDatabaseFrom(adapter) }) });
}

async function init() {
  if (!isDistributed()) {
    const db = await createSqlite();
    state.instance = db;
    return db;
  }

  // A fresh external database has no tables at all, and several instances may
  // boot against it at once, so creation is idempotent and tolerates the race.
  const db = await createPostgres();
  const { createSchema, syncColumns } = await import("./schemaKysely.js");
  await createSchema(db);
  await syncColumns(db);
  console.log(`[DB] distributed mode — schema ready`);
  state.instance = db;
  return db;
}

export async function getDb() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = init().catch((e) => { state.initPromise = null; throw e; });
  return state.initPromise;
}

export async function closeDb() {
  const db = state.instance;
  state.instance = null;
  state.initPromise = null;
  if (db) await db.destroy().catch(() => {});
  state.pool = null;
}
