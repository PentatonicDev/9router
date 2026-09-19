import { sql } from "kysely";
import { getDb } from "../kysely.js";
import { getInstanceId } from "@/lib/instanceId.js";

// One writer appends its own lines; every instance reads the whole table. The
// in-process buffer already caps what THIS process keeps in memory, so this is
// the cross-instance view of the same output.
const MAX_ROWS = 5000;

export async function appendConsoleLogs(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const db = await getDb();
  const instanceId = getInstanceId();
  const timestamp = new Date().toISOString();
  const rows = lines.map((line) => ({ instanceId, timestamp, line: String(line) }));
  await db.insertInto("consoleLogs").values(rows).execute();

  // Find the oldest id inside the newest MAX_ROWS, then delete everything before
  // it in one indexed statement. No COUNT(*) and no id list: with many writers,
  // every flush stays bounded by the primary-key lookup rather than table size.
  const cutoff = await db.selectFrom("consoleLogs").select("id")
    .orderBy("id", "desc").offset(MAX_ROWS - 1).limit(1).executeTakeFirst();
  if (cutoff) {
    await db.deleteFrom("consoleLogs").where("id", "<", Number(cutoff.id)).execute();
  }
}

// Lines newer than `sinceId`, oldest first, so the client can poll by cursor.
export async function getConsoleLogsSince(sinceId = 0, limit = 500) {
  const db = await getDb();
  const rows = await db.selectFrom("consoleLogs")
    .select(["id", "instanceId", "timestamp", "line"])
    .where("id", ">", Number(sinceId) || 0)
    .orderBy("id", "asc").limit(limit).execute();
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function getRecentConsoleLogs(limit = 200) {
  const db = await getDb();
  const rows = await db.selectFrom("consoleLogs")
    .select(["id", "instanceId", "timestamp", "line"])
    .orderBy("id", "desc").limit(limit).execute();
  return rows.reverse().map((r) => ({ ...r, id: Number(r.id) }));
}

// Which instances have written recently — the dashboard's instance picker.
export async function getConsoleLogInstances() {
  const db = await getDb();
  const rows = await db.selectFrom("consoleLogs")
    .select(["instanceId", sql`max(timestamp)`.as("lastSeen")])
    .groupBy("instanceId").orderBy("instanceId", "asc").execute();
  return rows;
}

export async function clearConsoleLogsFromDb() {
  const db = await getDb();
  await db.deleteFrom("consoleLogs").execute();
}
