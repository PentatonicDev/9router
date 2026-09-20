// End-to-end admin-API-key auth chain: apiKeysRepo (real DB) ->
// dashboardGuard.proxy() -> resourceScope.getRequestIdentity() -> keys routes.
// Only the Next.js request-scope helpers (next/headers, next/server) are
// stand-ins for what a real request supplies; the DB layer, dashboardSession
// and resourceScope are all the real modules, exercising the actual dynamic
// import (apiKeysRepo <-> resourceScope) rather than a mocked stub of it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const NEXT_SENTINEL = Symbol("next");
const cookieMock = vi.fn(() => undefined);
const headerMock = vi.fn(() => null);

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name) => cookieMock(name) }),
  headers: async () => ({ get: (name) => headerMock(name) }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => NEXT_SENTINEL),
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

// Set (and restore) DATA_DIR synchronously at module top level, matching every
// other real-DB test file's convention — other test files do the same at their
// own module scope, and process.env is process-wide, so doing this inside an
// async beforeAll would race a sibling file's own DATA_DIR the moment either
// hook awaits.
const originalDataDir = process.env.DATA_DIR;
const tempDir = mkdtempSync(join(tmpdir(), "9router-admin-key-"));
process.env.DATA_DIR = tempDir;

let db;
let proxy;
let getRequestIdentity;
let getScopeFilter;
let canSee;
let keysRouteGET;
let keysRoutePOST;
let keyByIdPUT;

const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";
const OWNER_INACTIVE = "owner-inactive@example.com"; // idx_ak_admin_owner is one per owner — needs its own

let adminKeyA;       // active, owner A, kind: admin
let adminKeyBHidden; // active, owner B, kind: admin — used to prove A can't see B's row
let usageKeyA;       // active, owner A, kind: usage
let sharedAdminKey;  // active, owner: null, kind: admin
let inactiveAdminKey; // inactive, owner A, kind: admin
let superAdminKey;   // active, owner "@admin", kind: admin

function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

function apiRequest(pathname, headers = {}, body) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: new Headers(headers),
    cookies: { get: () => undefined },
    url: `http://localhost${pathname}`,
    json: async () => body,
  };
}

// Drives getRequestIdentity()/getScopeFilter() through the mocked next/headers,
// exactly as a request carrying only this header (no dashboard cookie) would.
function asRequester(key) {
  cookieMock.mockReturnValue(undefined);
  headerMock.mockImplementation((name) => {
    if (name === "authorization") return key ? `Bearer ${key}` : null;
    return null;
  });
}

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ scopeResourcesByUser: true, requireLogin: true });

  adminKeyA = (await db.createApiKey("Admin A", "machine-a", null, OWNER_A, "admin")).key;
  adminKeyBHidden = (await db.createApiKey("Admin B", "machine-b", null, OWNER_B, "admin")).key;
  usageKeyA = (await db.createApiKey("Routing A", "machine-c", null, OWNER_A, "usage")).key;
  sharedAdminKey = (await db.createApiKey("Shared admin", "machine-d", null, null, "admin")).key;
  superAdminKey = (await db.createApiKey("Super admin", "machine-e", null, "@admin", "admin")).key;

  const inactive = await db.createApiKey("Inactive admin", "machine-f", null, OWNER_INACTIVE, "admin");
  await db.updateApiKey(inactive.id, { isActive: false });
  inactiveAdminKey = inactive.key;

  ({ proxy } = await import("@/dashboardGuard.js"));
  ({ getRequestIdentity, getScopeFilter, canSee } = await import("@/lib/auth/resourceScope.js"));
  ({ GET: keysRouteGET, POST: keysRoutePOST } = await import("@/app/api/keys/route.js"));
  ({ PUT: keyByIdPUT } = await import("@/app/api/keys/[id]/route.js"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("dashboardGuard.proxy — admin API key on a protected /api/* route", () => {
  it("allows an active, owned, admin key", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(adminKeyA)));
    expect(res).toBe(NEXT_SENTINEL);
  });

  // Mutation-proof: only kind differs from the passing case above.
  it("rejects an active, owned key with kind: usage", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(usageKeyA)));
    expect(res.status).toBe(401);
  });

  // Mutation-proof: only owner differs from the passing case above.
  it("rejects a shared (no-owner) key even with kind: admin", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(sharedAdminKey)));
    expect(res.status).toBe(401);
  });

  it("rejects an inactive, owned, admin key", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(inactiveAdminKey)));
    expect(res.status).toBe(401);
  });

  it("rejects the same admin key sent only via the ?key= query string", async () => {
    const res = await proxy(apiRequest(`/api/keys?key=${adminKeyA}`));
    expect(res.status).toBe(401);
  });

  it("never authenticates an ALWAYS_PROTECTED route with an admin key", async () => {
    const res = await proxy(apiRequest("/api/shutdown", bearer(adminKeyA)));
    expect(res.status).toBe(401);
  });

  it("an @admin-owned admin key passes an ADMIN_ONLY_PATH", async () => {
    const res = await proxy(apiRequest("/api/proxy-pools", bearer(superAdminKey)));
    expect(res).toBe(NEXT_SENTINEL);
  });

  it("a non-admin-owned admin key is rejected on an ADMIN_ONLY_PATH", async () => {
    const res = await proxy(apiRequest("/api/proxy-pools", bearer(adminKeyA)));
    expect(res.status).toBe(403);
  });
});

describe("resourceScope.getRequestIdentity — real repo, dynamic-import path", () => {
  it("resolves an admin key to its owner's identity, non-admin session", async () => {
    asRequester(adminKeyA);
    expect(await getRequestIdentity()).toEqual({ isAdmin: false, owner: OWNER_A });
  });

  it("resolves an @admin-owned admin key as admin", async () => {
    asRequester(superAdminKey);
    expect(await getRequestIdentity()).toEqual({ isAdmin: true, owner: "@admin" });
  });

  it("an admin key of owner A cannot see owner B's resources", async () => {
    asRequester(adminKeyA);
    const filter = await getScopeFilter();
    expect(filter).toEqual({ owner: OWNER_A });
    expect(canSee({ owner: OWNER_A }, filter)).toBe(true);
    expect(canSee({ owner: OWNER_B }, filter)).toBe(false);
  });
});

describe("GET /api/keys — full route through an admin key's scope filter", () => {
  it("owner A's admin key lists only its own and shared keys, never owner B's", async () => {
    asRequester(adminKeyA);
    const res = await keysRouteGET();
    const owners = res.body.keys.map((k) => k.owner);
    expect(owners).toContain(OWNER_A);
    expect(owners).toContain(null); // the shared admin key
    expect(owners).not.toContain(OWNER_B);
  });
});

describe("POST /api/keys — one admin key per owner (route-level 409)", () => {
  it("first admin key for a fresh owner succeeds", async () => {
    asRequester(superAdminKey); // acting as @admin, which is_Admin=true
    const res = await keysRoutePOST(apiRequest("/api/keys", bearer(superAdminKey), {
      name: "First admin key", kind: "admin", owner: "owner-c@example.com",
    }));
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("admin");
  });

  it("a second admin key for the same owner is rejected with 409", async () => {
    asRequester(superAdminKey);
    const res = await keysRoutePOST(apiRequest("/api/keys", bearer(superAdminKey), {
      name: "Second admin key", kind: "admin", owner: "owner-c@example.com",
    }));
    expect(res.status).toBe(409);
  });

  it("an admin key with an explicit null owner is rejected with 400", async () => {
    asRequester(superAdminKey);
    const res = await keysRoutePOST(apiRequest("/api/keys", bearer(superAdminKey), {
      name: "Ownerless admin key", kind: "admin", owner: null,
    }));
    expect(res.status).toBe(400);
  });

  it("a non-admin caller's kind:admin request is silently downgraded to usage, never rejected", async () => {
    asRequester(usageKeyA); // owner A, kind usage — not an admin identity
    const res = await keysRoutePOST(apiRequest("/api/keys", bearer(usageKeyA), {
      name: "Attempted admin key", kind: "admin",
    }));
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("usage");
  });
});

describe("PUT /api/keys/[id] — rotating an existing key into kind:admin re-checks the invariant", () => {
  it("promoting owner B's routing key to admin while B already has one is rejected with 409", async () => {
    const routingB = await db.createApiKey("Routing B", "machine-g", null, OWNER_B, "usage");
    asRequester(superAdminKey);
    const res = await keyByIdPUT(
      apiRequest(`/api/keys/${routingB.id}`, bearer(superAdminKey), { kind: "admin" }),
      { params: Promise.resolve({ id: routingB.id }) },
    );
    expect(res.status).toBe(409);
  });
});

// Mutation-proof for the /v1 admin-key refusal itself lives in
// tests/unit/admin-key-refused-on-v1.test.js (chat.js is a much heavier module
// to stand up than this file's dashboardGuard/route surface).
describe("DB race — idx_ak_admin_owner rejects a second admin key for the same owner", () => {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const REPO_ROOT = path.resolve(__dirname, "../..");
  const LOADER = path.join(REPO_ROOT, "tests/fixtures/register-loader.mjs");
  const WORKER = path.join(REPO_ROOT, "tests/fixtures/admin-key-race-worker.mjs");
  const PG_URL = process.env.KEYS_TEST_DATABASE_URL || "postgresql://test:test@127.0.0.1:55432/rel_keys";

  function runWorker(args, env = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", LOADER, WORKER, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) { reject(new Error(`worker exited with ${code}: ${stderr}`)); return; }
        const lastLine = stdout.trim().split("\n").pop();
        try { resolve(JSON.parse(lastLine)); }
        catch { reject(new Error(`could not parse worker output: ${stdout}`)); }
      });
    });
  }

  it("SQLite: exactly one of two concurrent admin-key inserts for the same owner wins", async () => {
    const raceDir = mkdtempSync(join(tmpdir(), "9router-admin-race-sqlite-"));
    try {
      const result = await runWorker(["race-owner-sqlite"], { DATA_DIR: raceDir, DATABASE_URL: "" });
      expect(result.fulfilled).toBe(1);
      expect(result.rejectedCount).toBe(1);
      expect(result.rejectedLooksLikeUniqueViolation).toBe(true);
    } finally {
      rmSync(raceDir, { recursive: true, force: true });
    }
  });

  it("Postgres: exactly one of two concurrent admin-key inserts for the same owner wins", async () => {
    // A fresh owner per run: this DB persists across test runs (unlike the
    // SQLite case's throwaway temp dir), so a fixed owner would only pass once.
    const owner = `race-owner-pg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await runWorker([owner], { DATABASE_URL: PG_URL });
    expect(result.fulfilled).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.rejectedLooksLikeUniqueViolation).toBe(true);
  });
});
