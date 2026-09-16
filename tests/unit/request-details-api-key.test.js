import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-rd-key-"));
process.env.ENABLE_REQUEST_LOGS = "true";

let repo;
let db;
const KEY_A = "sk-detailaaaa";
const KEY_B = "sk-detailbbbb";

// A missing column must surface as a failing assertion, not as a crashed
// beforeAll — a suite that dies during setup reports "skipped" and would hide
// the very regression this file exists to catch.
let setupError = null;

beforeAll(async () => {
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    db = await getAdapter();
    repo = await import("@/lib/db/repos/requestDetailsRepo.js");
  } catch (e) {
    setupError = e;
    return;
  }

  // Write straight to the table: saveRequestDetail buffers behind an
  // observability config this test does not control.
  const insert = (id, apiKey, model) => db.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, apiKey, status, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, new Date().toISOString(), "claude", model, "conn-1", apiKey, "success",
     JSON.stringify({ id, provider: "claude", model, apiKeyMasked: apiKey.slice(0, 8) + "***" })]
  );
  try {
    insert("d1", KEY_A, "claude-opus-5");
    insert("d2", KEY_A, "claude-sonnet-5");
    insert("d3", KEY_B, "claude-haiku-4-5");
  } catch (e) {
    setupError = e;
  }
});

describe("requestDetails.apiKey", () => {
  it("is created by the additive schema sync", () => {
    expect(setupError?.message ?? null).toBeNull();
    expect(db.all(`PRAGMA table_info(requestDetails)`).map((c) => c.name)).toContain("apiKey");
  });

  it("filters details by key", async () => {
    const all = await repo.getRequestDetails({});
    expect(all.pagination.totalItems).toBe(3);

    const onlyA = await repo.getRequestDetails({ apiKey: KEY_A });
    expect(onlyA.pagination.totalItems).toBe(2);
    expect(onlyA.details.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
  });

  it("exposes the key masked, never raw", async () => {
    const onlyA = await repo.getRequestDetails({ apiKey: KEY_A });
    expect(onlyA.details[0].apiKeyMasked).toBe("sk-detai***");
    expect(JSON.stringify(onlyA.details)).not.toContain(KEY_A);
  });
});
