// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 5;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      // Owning dashboard user: NULL = shared, "@admin" = password login only,
      // otherwise the SSO e-mail. Only enforced while scopeResourcesByUser is on.
      owner: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_owner ON providerConnections(owner)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      // JSON array of providerConnections.id this key may route to.
      // NULL/empty = unrestricted (the key reaches every account).
      allowedConnectionIds: "TEXT",
      // JSON array of free-form labels, for grouping/filtering keys only.
      tags: "TEXT",
      // See providerConnections.owner. A key's owner also caps which accounts it
      // may route to at runtime.
      owner: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE INDEX IF NOT EXISTS idx_ak_owner ON apiKeys(owner)",
    ],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      // Unique per owner, not globally: two users may each own a "fast" combo.
      // The uniqueness lives in idx_combo_owner_name below, since NULL owners
      // would escape a table-level UNIQUE(name, owner).
      name: "TEXT NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      // See providerConnections.owner.
      owner: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_owner_name ON combos(name, IFNULL(owner, ''))",
    ],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_apikey ON usageHistory(apiKey)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_rd_apikey ON requestDetails(apiKey)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}

// Indexes declared structurally so each dialect emits its own DDL: Postgres
// folds unquoted identifiers to lower case and has no IFNULL, so the raw
// SQLite strings these replaced only ever worked on SQLite.
export const INDEXES = [
  { name: "idx_pc_owner", table: "providerConnections", columns: ["owner"], unique: false },
  { name: "idx_pc_provider", table: "providerConnections", columns: ["provider"], unique: false },
  { name: "idx_pc_provider_active", table: "providerConnections", columns: ["provider", "isActive"], unique: false },
  { name: "idx_pc_priority", table: "providerConnections", columns: ["provider", "priority"], unique: false },
  { name: "idx_pn_type", table: "providerNodes", columns: ["type"], unique: false },
  { name: "idx_pp_active", table: "proxyPools", columns: ["isActive"], unique: false },
  { name: "idx_pp_status", table: "proxyPools", columns: ["testStatus"], unique: false },
  { name: "idx_ak_key", table: "apiKeys", columns: ["key"], unique: false },
  { name: "idx_ak_owner", table: "apiKeys", columns: ["owner"], unique: false },
  { name: "idx_combo_name", table: "combos", columns: ["name"], unique: false },
  { name: "idx_combo_owner_name", table: "combos", expression: { sqlite: "name, IFNULL(owner, '')", pg: "name, COALESCE(owner, '')" }, unique: true },
  { name: "idx_kv_scope", table: "kv", columns: ["scope"], unique: false },
  { name: "idx_uh_ts", table: "usageHistory", columns: ["timestamp"], order: "desc", unique: false },
  { name: "idx_uh_provider", table: "usageHistory", columns: ["provider"], unique: false },
  { name: "idx_uh_model", table: "usageHistory", columns: ["model"], unique: false },
  { name: "idx_uh_conn", table: "usageHistory", columns: ["connectionId"], unique: false },
  { name: "idx_uh_apikey", table: "usageHistory", columns: ["apiKey"], unique: false },
  { name: "idx_rd_ts", table: "requestDetails", columns: ["timestamp"], order: "desc", unique: false },
  { name: "idx_rd_provider", table: "requestDetails", columns: ["provider"], unique: false },
  { name: "idx_rd_model", table: "requestDetails", columns: ["model"], unique: false },
  { name: "idx_rd_conn", table: "requestDetails", columns: ["connectionId"], unique: false },
  { name: "idx_rd_apikey", table: "requestDetails", columns: ["apiKey"], unique: false },
];
