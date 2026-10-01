// A combo answers to its name and to every alias; a name beats an alias, and the
// alias follows the same owner/hidden rules as the name. Runs on a real SQLite file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getComboModelsFromData } from "open-sse/services/combo.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-aliases-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.createCombo({ name: "opus", models: ["cc/claude-opus-5-5"], aliases: ["claude-opus-5", "claude_x"], owner: null });
  await db.createCombo({ name: "claude-opus-5", models: ["cx/gpt-6-sol"], owner: "bob@x.com" });
  await db.createCombo({ name: "fast", models: ["cx/gpt-6-luna"], aliases: ["claude-haiku-4-5"], owner: "ann@x.com" });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("combo aliases", () => {
  it("resolves a shared combo by alias and round-trips the column", async () => {
    const hit = await db.getComboByName("claude-opus-5", null);
    expect(hit?.name).toBe("opus");
    expect(hit.aliases).toEqual(["claude-opus-5", "claude_x"]);
  });

  it("does not treat LIKE wildcards as a match", async () => {
    expect(await db.getComboByName("claudeAx", null)).toBeNull();
  });

  it("the user's own combo name beats a shared alias", async () => {
    expect((await db.getComboByName("claude-opus-5", "bob@x.com"))?.name).toBe("claude-opus-5");
    expect((await db.getComboByName("claude-opus-5", "ann@x.com"))?.name).toBe("opus");
  });

  it("an owner's alias does not leak to other owners", async () => {
    expect((await db.getComboByName("claude-haiku-4-5", "ann@x.com"))?.name).toBe("fast");
    expect(await db.getComboByName("claude-haiku-4-5", "bob@x.com")).toBeNull();
  });

  it("hiding a shared combo hides its aliases too", async () => {
    const { hideGlobalCombo } = await import("@/lib/db/repos/hiddenCombosRepo.js");
    await hideGlobalCombo("ann@x.com", "opus");
    expect(await db.getComboByName("claude_x", "ann@x.com")).toBeNull();
  });

  it("updateCombo persists aliases and exportDb carries them", async () => {
    const fast = await db.getComboByName("fast", "ann@x.com");
    await db.updateCombo(fast.id, { name: "fast-2", aliases: ["fast", "claude-haiku-4-5"] });
    expect((await db.getComboByName("fast", "ann@x.com"))?.name).toBe("fast-2");
    const dump = await db.exportDb();
    expect(dump.combos.find((c) => c.name === "fast-2").aliases).toEqual(["fast", "claude-haiku-4-5"]);
  });

  it("in-memory lookup (search/fetch) honours aliases", () => {
    const combos = [{ name: "web", models: ["a"], aliases: ["search-default"] }];
    expect(getComboModelsFromData("search-default", combos)).toEqual(["a"]);
  });
});

describe("combo alias API guards", () => {
  it("rejects an alias already answering for another combo, and a bad alias", async () => {
    vi.resetModules();
    vi.doMock("next/server", () => ({ NextResponse: { json: (b, i = {}) => new Response(JSON.stringify(b), { status: i.status || 200 }) } }));
    vi.doMock("@/lib/auth/resourceScope", async (orig) => ({
      ...(await orig()),
      getRequestIdentity: async () => ({ isAdmin: true, owner: null }),
      ownerForCreate: async () => null,
    }));
    const { POST } = await import("@/app/api/combos/route.js");
    const post = (body) => POST(new Request("http://x/api/combos", { method: "POST", body: JSON.stringify(body) }));

    const clash = await post({ name: "new-one", models: ["a/b"], aliases: ["claude_x"] });
    expect(clash.status).toBe(400);
    expect((await clash.json()).error).toContain('combo "opus"');

    expect((await post({ name: "new-two", models: ["a/b"], aliases: ["bad alias"] })).status).toBe(400);
    expect((await post({ name: "new-three", models: ["a/b"], aliases: ["new-three"] })).status).toBe(400);
    expect((await post({ name: "new-four", models: ["a/b"], aliases: ["free-alias"] })).status).toBe(201);
    vi.doUnmock("next/server"); vi.doUnmock("@/lib/auth/resourceScope");
  });
});
