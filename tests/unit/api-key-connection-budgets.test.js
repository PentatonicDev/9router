// apiKeys.connectionBudgets: the spend-cap plumbing SPEND consumes.
// normalizeConnectionBudgets is pure structural validation; the DB round-trip
// and owner-change pruning need the real repo/DB, same pattern as
// api-key-tags.test.js for allowedConnectionIds/tags.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-key-budgets-"));

let repo;
let db;

beforeAll(async () => {
  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
});

describe("normalizeConnectionBudgets", () => {
  it("accepts a valid map", () => {
    expect(repo.normalizeConnectionBudgets({ "conn-a": { limitUsd: 10, period: "month" } }))
      .toEqual({ "conn-a": { limitUsd: 10, period: "month" } });
  });

  it("accepts both period values", () => {
    expect(repo.normalizeConnectionBudgets({ a: { limitUsd: 1, period: "month" } })).toEqual({ a: { limitUsd: 1, period: "month" } });
    expect(repo.normalizeConnectionBudgets({ a: { limitUsd: 1, period: "total" } })).toEqual({ a: { limitUsd: 1, period: "total" } });
  });

  it("drops an entry with limitUsd <= 0 (mutation-proof: only the boundary value differs)", () => {
    expect(repo.normalizeConnectionBudgets({ a: { limitUsd: 0, period: "month" } })).toBeNull();
    expect(repo.normalizeConnectionBudgets({ a: { limitUsd: -5, period: "month" } })).toBeNull();
  });

  it("drops an entry with a non-numeric limitUsd", () => {
    expect(repo.normalizeConnectionBudgets({ a: { limitUsd: "ten", period: "month" } })).toBeNull();
  });

  it("drops an entry with an invalid period", () => {
    expect(repo.normalizeConnectionBudgets({ a: { limitUsd: 5, period: "week" } })).toBeNull();
  });

  it("prunes a connectionId not in the given allowedConnectionIds", () => {
    const out = repo.normalizeConnectionBudgets(
      { a: { limitUsd: 5, period: "month" }, b: { limitUsd: 5, period: "month" } },
      ["a"],
    );
    expect(out).toEqual({ a: { limitUsd: 5, period: "month" } });
  });

  it("prunes nothing when allowedConnectionIds is null (unrestricted)", () => {
    const out = repo.normalizeConnectionBudgets({ a: { limitUsd: 5, period: "month" } }, null);
    expect(out).toEqual({ a: { limitUsd: 5, period: "month" } });
  });

  it("empty map normalizes to null, matching allowedConnectionIds/tags convention", () => {
    expect(repo.normalizeConnectionBudgets({})).toBeNull();
  });

  it("non-object input normalizes to null", () => {
    expect(repo.normalizeConnectionBudgets(null)).toBeNull();
    expect(repo.normalizeConnectionBudgets("nope")).toBeNull();
    expect(repo.normalizeConnectionBudgets([])).toBeNull();
  });
});

describe("apiKeys.connectionBudgets — DB round-trip", () => {
  it("defaults to {} on a fresh key", async () => {
    const key = await repo.createApiKey("no-budgets", "m1");
    expect(key.connectionBudgets).toEqual({});
    expect((await repo.getApiKeyById(key.id)).connectionBudgets).toEqual({});
    expect(await repo.getApiKeyConnectionBudgets(key.key)).toEqual({});
  });

  it("round-trips a budget set via updateApiKey", async () => {
    const key = await repo.createApiKey("budgeted", "m1");
    await repo.updateApiKey(key.id, {
      allowedConnectionIds: ["conn-a", "conn-b"],
      connectionBudgets: { "conn-a": { limitUsd: 25, period: "month" } },
    });
    const reloaded = await repo.getApiKeyById(key.id);
    expect(reloaded.connectionBudgets).toEqual({ "conn-a": { limitUsd: 25, period: "month" } });
    expect(await repo.getApiKeyConnectionBudgets(key.key)).toEqual({ "conn-a": { limitUsd: 25, period: "month" } });
  });

  it("an owner change prunes a budget on a connection the new owner cannot reach", async () => {
    await db.run(
      `INSERT INTO providerConnections (id, provider, authType, owner, data, createdAt, updatedAt) VALUES (?, 'openai', 'apikey', 'owner-a@example.com', '{}', ?, ?)`,
      ["conn-owned-by-a", new Date().toISOString(), new Date().toISOString()],
    );
    const key = await repo.createApiKey("reassigned", "m1", null, "owner-a@example.com");
    await repo.updateApiKey(key.id, {
      allowedConnectionIds: ["conn-owned-by-a"],
      connectionBudgets: { "conn-owned-by-a": { limitUsd: 5, period: "total" } },
    });

    const moved = await repo.updateApiKey(key.id, { owner: "owner-b@example.com" });
    expect(moved.allowedConnectionIds).toBeNull(); // reachableConnectionIds already prunes this
    expect(moved.connectionBudgets).toBeNull(); // and the budget riding on it must not survive either
  });
});

describe("getAdminKeyByOwner", () => {
  it("finds the one admin key for an owner", async () => {
    const admin = await repo.createApiKey("Admin", "m2", null, "owner-admin@example.com", "admin");
    const found = await repo.getAdminKeyByOwner("owner-admin@example.com");
    expect(found?.id).toBe(admin.id);
  });

  it("returns null for an owner with no admin key", async () => {
    expect(await repo.getAdminKeyByOwner("nobody@example.com")).toBeNull();
  });

  it("excludeId lets a PUT re-check without self-conflicting", async () => {
    const admin = await repo.createApiKey("Self", "m3", null, "owner-self@example.com", "admin");
    expect(await repo.getAdminKeyByOwner("owner-self@example.com", admin.id)).toBeNull();
  });
});
