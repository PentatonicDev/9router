// End-to-end management-API-key auth chain: apiKeysRepo (real DB) ->
// dashboardGuard.proxy() -> resourceScope.getRequestIdentity(). Only the
// Next.js request-scope helpers (next/headers, next/server) are stand-ins for
// what a real request supplies; the DB layer, dashboardSession and
// resourceScope are all the real modules, exercising the actual dynamic
// import (apiKeysRepo <-> resourceScope) rather than a mocked stub of it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const tempDir = mkdtempSync(join(tmpdir(), "9router-mgmt-key-"));
process.env.DATA_DIR = tempDir;

let db;
let proxy;
let getRequestIdentity;
let getScopeFilter;
let canSee;
let keysRouteGET;

const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";

let managedKeyA;       // active, owner A, management: true
let managedKeyBHidden; // active, owner B, management: true — used to prove A can't see B's row
let unmanagedKeyA;     // active, owner A, management: false
let sharedManagedKey;  // active, owner: null, management: true
let inactiveManagedKey; // inactive, owner A, management: true
let adminManagedKey;   // active, owner "@admin", management: true

function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

function apiRequest(pathname, headers = {}) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: new Headers(headers),
    cookies: { get: () => undefined },
    url: `http://localhost${pathname}`,
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

  managedKeyA = (await db.createApiKey("Managed A", "machine-a", null, OWNER_A, true)).key;
  managedKeyBHidden = (await db.createApiKey("Managed B", "machine-b", null, OWNER_B, true)).key;
  unmanagedKeyA = (await db.createApiKey("Routing A", "machine-c", null, OWNER_A, false)).key;
  sharedManagedKey = (await db.createApiKey("Shared managed", "machine-d", null, null, true)).key;
  adminManagedKey = (await db.createApiKey("Admin managed", "machine-e", null, "@admin", true)).key;

  const inactive = await db.createApiKey("Inactive managed", "machine-f", null, OWNER_A, true);
  await db.updateApiKey(inactive.id, { isActive: false });
  inactiveManagedKey = inactive.key;

  ({ proxy } = await import("@/dashboardGuard.js"));
  ({ getRequestIdentity, getScopeFilter, canSee } = await import("@/lib/auth/resourceScope.js"));
  ({ GET: keysRouteGET } = await import("@/app/api/keys/route.js"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("dashboardGuard.proxy — management API key on a protected /api/* route", () => {
  it("allows an active, owned, management key", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(managedKeyA)));
    expect(res).toBe(NEXT_SENTINEL);
  });

  // Mutation-proof: only management differs from the passing case above.
  it("rejects an active, owned key with management: false", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(unmanagedKeyA)));
    expect(res.status).toBe(401);
  });

  // Mutation-proof: only owner differs from the passing case above.
  it("rejects a shared (no-owner) key even with management: true", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(sharedManagedKey)));
    expect(res.status).toBe(401);
  });

  it("rejects an inactive, owned, management key", async () => {
    const res = await proxy(apiRequest("/api/keys", bearer(inactiveManagedKey)));
    expect(res.status).toBe(401);
  });

  it("rejects the same management key sent only via the ?key= query string", async () => {
    const res = await proxy(apiRequest(`/api/keys?key=${managedKeyA}`));
    expect(res.status).toBe(401);
  });

  it("never authenticates an ALWAYS_PROTECTED route with a management key", async () => {
    const res = await proxy(apiRequest("/api/shutdown", bearer(managedKeyA)));
    expect(res.status).toBe(401);
  });

  it("an @admin-owned management key passes an ADMIN_ONLY_PATH", async () => {
    const res = await proxy(apiRequest("/api/proxy-pools", bearer(adminManagedKey)));
    expect(res).toBe(NEXT_SENTINEL);
  });

  it("a non-admin-owned management key is rejected on an ADMIN_ONLY_PATH", async () => {
    const res = await proxy(apiRequest("/api/proxy-pools", bearer(managedKeyA)));
    expect(res.status).toBe(403);
  });
});

describe("resourceScope.getRequestIdentity — real repo, dynamic-import path", () => {
  it("resolves a management key to its owner's identity, non-admin", async () => {
    asRequester(managedKeyA);
    expect(await getRequestIdentity()).toEqual({ isAdmin: false, owner: OWNER_A });
  });

  it("resolves an @admin-owned management key as admin", async () => {
    asRequester(adminManagedKey);
    expect(await getRequestIdentity()).toEqual({ isAdmin: true, owner: "@admin" });
  });

  it("a management key of owner A cannot see owner B's resources", async () => {
    asRequester(managedKeyA);
    const filter = await getScopeFilter();
    expect(filter).toEqual({ owner: OWNER_A });
    expect(canSee({ owner: OWNER_A }, filter)).toBe(true);
    expect(canSee({ owner: OWNER_B }, filter)).toBe(false);
  });
});

describe("GET /api/keys — full route through a management key's scope filter", () => {
  it("owner A's management key lists only its own and shared keys, never owner B's", async () => {
    asRequester(managedKeyA);
    const res = await keysRouteGET();
    const owners = res.body.keys.map((k) => k.owner);
    expect(owners).toContain(OWNER_A);
    expect(owners).toContain(null); // the shared-managed key
    expect(owners).not.toContain(OWNER_B);
  });
});
