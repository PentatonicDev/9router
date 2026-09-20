// Real-SQLite integration for the spend-cap feature end to end: a budgeted
// connection is selectable right up to its cap, excluded once spend reaches
// it, and — when that empties the whole pool — getProviderCredentials
// returns a 402 candidate that responseFromRoutingCandidate turns into a real
// Response carrying X-9Router-Reason: spend_cap_exceeded (the exact one-liner
// src/sse/handlers/chat.js needs to add — see this track's report).
// Also covers: a month-keyed budget resets when the month rolls over, and a
// provider/model with no pricing entry never accrues ledger spend (so its cap
// never binds — the "cost 0" rollout risk, exercised rather than assumed).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "9r-spend-cap-"));
process.env.DATA_DIR = dataDir;

let getDb, createApiKey, updateApiKey, createProviderConnection;
let getProviderCredentials;
let recordSpend, getApiKeyConnectionBudgets, _clearBudgetCacheForTests, monthKeyUTC, TOTAL_PERIOD_KEY;
let responseFromRoutingCandidate, saveRequestUsage;

let connId;
const API_KEY_VALUE_HOLDER = {};

beforeAll(async () => {
  ({ getDb } = await import("@/lib/db/kysely.js"));
  ({ createApiKey, updateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js"));
  ({ createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js"));
  ({ getProviderCredentials } = await import("@/sse/services/auth.js"));
  ({ recordSpend, getApiKeyConnectionBudgets, _clearBudgetCacheForTests, monthKeyUTC, TOTAL_PERIOD_KEY } =
    await import("@/lib/db/repos/spendLedgerRepo.js"));
  ({ responseFromRoutingCandidate } = await import("open-sse/utils/error.js"));
  ({ saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js"));

  const conn = await createProviderConnection({
    provider: "claude", name: "spend-cap-conn", authType: "apikey", apiKey: "test-upstream-key",
  });
  connId = conn.id;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function seedLedger(apiKey, periodKey, costUsd) {
  const db = await getDb();
  await db.insertInto("spendLedger").values({ apiKey, connectionId: connId, periodKey, costUsd, updatedAt: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["apiKey", "connectionId", "periodKey"]).doUpdateSet({ costUsd }))
    .execute();
}

describe("spend cap enforcement (total period)", () => {
  let apiKeyValue;

  beforeAll(async () => {
    const key = await createApiKey("spend-cap-total", "machine-1");
    await updateApiKey(key.id, {
      allowedConnectionIds: [connId],
      connectionBudgets: { [connId]: { limitUsd: 1, period: "total" } },
    });
    apiKeyValue = key.key;
  });

  it("stays selectable just under the cap", async () => {
    _clearBudgetCacheForTests();
    await seedLedger(apiKeyValue, TOTAL_PERIOD_KEY, 0.99);

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: apiKeyValue });

    expect(credentials.connectionId).toBe(connId);
  });

  it("excludes the connection once spend reaches the cap", async () => {
    _clearBudgetCacheForTests();
    await seedLedger(apiKeyValue, TOTAL_PERIOD_KEY, 1.0);

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: apiKeyValue });

    expect(credentials.spendCapExceeded).toBe(true);
    expect(credentials.candidate.status).toBe(402);
    expect(credentials.candidate.reason).toBe("spend_cap_exceeded");
  });

  it("responseFromRoutingCandidate turns that candidate into a real 402 with the reason header — the exact plumbing chat.js's spendCapExceeded branch reuses", async () => {
    _clearBudgetCacheForTests();
    await seedLedger(apiKeyValue, TOTAL_PERIOD_KEY, 1.0);
    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: apiKeyValue });

    const response = responseFromRoutingCandidate(credentials.candidate, {});

    expect(response.status).toBe(402);
    expect(response.headers.get("X-9Router-Reason")).toBe("spend_cap_exceeded");
  });
});

describe("spend cap enforcement (monthly period rollover)", () => {
  let apiKeyValue;

  beforeAll(async () => {
    const key = await createApiKey("spend-cap-month", "machine-1");
    await updateApiKey(key.id, {
      allowedConnectionIds: [connId],
      connectionBudgets: { [connId]: { limitUsd: 1, period: "month" } },
    });
    apiKeyValue = key.key;
  });

  it("an over-cap spend recorded in a past month does not exclude the connection this month", async () => {
    _clearBudgetCacheForTests();
    await seedLedger(apiKeyValue, "2020-01", 5.0); // way over cap, but a different periodKey
    expect(monthKeyUTC(new Date("2020-01-15"))).toBe("2020-01");

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: apiKeyValue });

    expect(credentials.connectionId).toBe(connId);
  });

  it("excludes the connection once the CURRENT month's ledger reaches the cap", async () => {
    _clearBudgetCacheForTests();
    await seedLedger(apiKeyValue, monthKeyUTC(), 1.0);

    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: apiKeyValue });

    expect(credentials.spendCapExceeded).toBe(true);
  });
});

describe("missing pricing → cost 0 → cap never binds", () => {
  let apiKeyValue;

  beforeAll(async () => {
    const key = await createApiKey("spend-cap-no-pricing", "machine-1");
    await updateApiKey(key.id, {
      allowedConnectionIds: [connId],
      connectionBudgets: { [connId]: { limitUsd: 1, period: "total" } },
    });
    apiKeyValue = key.key;
  });

  it("saveRequestUsage against an unpriced model writes no ledger row (cost stayed 0)", async () => {
    for (let i = 0; i < 5; i++) {
      await saveRequestUsage({
        timestamp: new Date(Date.now() + i).toISOString(),
        provider: "totally-unpriced-test-provider",
        model: "totally-unpriced-test-model",
        apiKey: apiKeyValue,
        connectionId: connId,
        tokens: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      });
    }

    const db = await getDb();
    const row = await db.selectFrom("spendLedger").select("costUsd")
      .where("apiKey", "=", apiKeyValue).where("connectionId", "=", connId).where("periodKey", "=", TOTAL_PERIOD_KEY)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("stays selectable regardless of request volume, since spend never accrues", async () => {
    _clearBudgetCacheForTests();
    const credentials = await getProviderCredentials("claude", null, "claude-sonnet-5", { apiKey: apiKeyValue });
    expect(credentials.connectionId).toBe(connId);
  });
});
