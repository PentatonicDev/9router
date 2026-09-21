import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A .env carrying ENABLE_REQUEST_LOGS=false (the debug file-log switch) must not
// veto the dashboard's Observability toggle.
const dir = mkdtempSync(join(tmpdir(), "9r-obs-prec-"));
process.env.DATA_DIR = dir;
process.env.ENABLE_REQUEST_LOGS = "false";

let repo, db, settingsRepo, kysely;

async function countRows() {
  const row = await db.selectFrom("requestDetails").select((eb) => eb.fn.countAll().as("c")).executeTakeFirst();
  return Number(row?.c ?? 0);
}

beforeAll(async () => {
  kysely = await import("@/lib/db/kysely.js");
  db = await kysely.getDb();
  settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
});

afterAll(async () => {
  await kysely.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("observability precedence", () => {
  it("records details when the toggle is on even though ENABLE_REQUEST_LOGS=false", async () => {
    await settingsRepo.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
    const before = await countRows();
    await repo.saveRequestDetail({
      provider: "bedrock", model: "m", connectionId: "c", apiKey: "k",
      latency: { ttft: 1, total: 2 }, tokens: { prompt_tokens: 1, completion_tokens: 1 },
      request: {}, providerRequest: null, providerResponse: null, response: { content: "x" }, status: "success",
    });
    // batchSize 1 flushes immediately; give the async write a moment.
    for (let i = 0; i < 20 && (await countRows()) === before; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await countRows()).toBe(before + 1);
  });
});
