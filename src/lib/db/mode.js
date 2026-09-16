// How this instance stores its data. Local is the default and needs no
// configuration; pointing DATABASE_URL at a Postgres switches the whole
// instance over, which is what lets several of them share one database.
import { DATA_FILE } from "./paths.js";

export const LOCAL = "local";
export const DISTRIBUTED = "distributed";

export function getDatabaseUrl() {
  return (process.env.DATABASE_URL || "").trim();
}

export function getDbMode() {
  return getDatabaseUrl() ? DISTRIBUTED : LOCAL;
}

export function isDistributed() {
  return getDbMode() === DISTRIBUTED;
}

/**
 * What the dashboard may show about the current database.
 * Never the password or the raw URL: this is rendered in a page and copied into
 * screenshots, so the credential must not travel with it.
 */
export function describeDatabase() {
  const url = getDatabaseUrl();
  if (!url) {
    return { mode: LOCAL, driver: "sqlite", file: DATA_FILE, label: "Local Mode" };
  }
  try {
    const parsed = new URL(url);
    return {
      mode: DISTRIBUTED,
      driver: parsed.protocol.replace(":", "") === "postgres" ? "postgresql" : parsed.protocol.replace(":", ""),
      host: parsed.hostname,
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, "") || null,
      user: parsed.username || null,
      ssl: parsed.searchParams.get("sslmode") || null,
      label: "Distributed Mode",
    };
  } catch {
    // A malformed URL still means the operator asked for an external database;
    // saying so beats silently falling back to local and splitting the data.
    return { mode: DISTRIBUTED, driver: "unknown", invalid: true, label: "Distributed Mode" };
  }
}
