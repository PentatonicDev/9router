import { describe, it, expect, vi, beforeEach } from "vitest";

// getSettings and the session reader are the only I/O in resourceScope; stub both
// so the visibility matrix is exercised as pure logic.
const settingsMock = vi.fn();
const sessionMock = vi.fn();
const cookieMock = vi.fn();
const headerMock = vi.fn();

vi.mock("@/lib/localDb", () => ({ getSettings: () => settingsMock() }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: (token) => sessionMock(token),
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: async () => "cli-token-value",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name) => cookieMock(name) }),
  headers: async () => ({ get: (name) => headerMock(name) }),
}));

const {
  ADMIN_OWNER, canSee, canEdit, normalizeOwner, normalizeOwnerInput,
  parseAdminEmails, getScopeFilter, getRequestIdentity, scopeVisible,
  resolveDefaultOwner, ownerForCreate,
} = await import("@/lib/auth/resourceScope");

const ALICE = "alice@corp.com";
const BOB = "bob@corp.com";

function session({ scope = true, email = null, admins = [], cliToken = null, authMode = "sso" } = {}) {
  settingsMock.mockResolvedValue({ scopeResourcesByUser: scope, ssoAdminEmails: admins, authMode });
  sessionMock.mockResolvedValue(email ? { oidcEmail: email } : { authenticated: true });
  cookieMock.mockReturnValue({ value: "token" });
  headerMock.mockReturnValue(cliToken);
}

beforeEach(() => vi.clearAllMocks());

describe("normalizeOwner", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeOwner("  Alice@Corp.com ")).toBe(ALICE);
  });

  it("refuses the admin sentinel from an IdP claim, so it cannot be forged", () => {
    expect(normalizeOwner(ADMIN_OWNER)).toBeNull();
    expect(normalizeOwner("@anything")).toBeNull();
    expect(normalizeOwner("")).toBeNull();
    expect(normalizeOwner(null)).toBeNull();
  });

  it("accepts the sentinel only through the dashboard input path", () => {
    expect(normalizeOwnerInput("@admin")).toBe(ADMIN_OWNER);
    expect(normalizeOwnerInput("  @ADMIN ")).toBe(ADMIN_OWNER);
    expect(normalizeOwnerInput("")).toBeNull();
  });
});

describe("parseAdminEmails", () => {
  it("accepts an array or a delimited string", () => {
    expect(parseAdminEmails([" Alice@corp.com ", "bob@corp.com"])).toEqual([ALICE, BOB]);
    expect(parseAdminEmails("alice@corp.com, bob@corp.com")).toEqual([ALICE, BOB]);
    expect(parseAdminEmails("")).toEqual([]);
  });
});

describe("visibility matrix", () => {
  const filter = { owner: ALICE };

  it("a null filter (scope off, or admin) sees everything", () => {
    for (const owner of [null, ALICE, BOB, ADMIN_OWNER]) {
      expect(canSee({ owner }, null)).toBe(true);
    }
  });

  it("a scoped user sees shared resources and their own", () => {
    expect(canSee({ owner: null }, filter)).toBe(true);
    expect(canSee({ owner: ALICE }, filter)).toBe(true);
  });

  it("a scoped user sees neither another user's nor admin-only resources", () => {
    expect(canSee({ owner: BOB }, filter)).toBe(false);
    expect(canSee({ owner: ADMIN_OWNER }, filter)).toBe(false);
  });

  it("edit reach matches see reach", () => {
    for (const owner of [null, ALICE, BOB, ADMIN_OWNER]) {
      expect(canEdit({ owner }, filter)).toBe(canSee({ owner }, filter));
    }
  });

  it("scopeVisible filters a list and is a no-op without a filter", () => {
    const rows = [{ owner: null }, { owner: ALICE }, { owner: BOB }, { owner: ADMIN_OWNER }];
    expect(scopeVisible(rows, filter)).toEqual([{ owner: null }, { owner: ALICE }]);
    expect(scopeVisible(rows, null)).toBe(rows);
  });
});

describe("getScopeFilter", () => {
  it("returns null when scoping is off — nothing is enforced (legacy behaviour)", async () => {
    session({ scope: false, email: ALICE });
    expect(await getScopeFilter()).toBeNull();
  });

  it("returns null for the password login", async () => {
    session({ email: null });
    expect(await getScopeFilter()).toBeNull();
  });

  it("returns the user's own predicate for a scoped SSO user", async () => {
    session({ email: ALICE });
    expect(await getScopeFilter()).toEqual({ owner: ALICE });
  });
});

describe("identity", () => {
  it("an SSO admin keeps its own e-mail as owner, so nothing is reassigned", async () => {
    session({ email: ALICE, admins: [ALICE] });
    expect(await getRequestIdentity()).toEqual({ isAdmin: true, owner: ALICE });
  });

  it("an SSO admin still sees everything while admin", async () => {
    session({ email: ALICE, admins: [ALICE] });
    expect(await getScopeFilter()).toBeNull();
  });

  it("losing admin keeps the user's own resources and drops the rest", async () => {
    session({ email: ALICE, admins: [] });
    const identity = await getRequestIdentity();
    expect(identity).toEqual({ isAdmin: false, owner: ALICE });

    const demoted = await getScopeFilter();
    expect(canSee({ owner: ALICE }, demoted)).toBe(true);   // still theirs
    expect(canSee({ owner: null }, demoted)).toBe(true);    // still shared
    expect(canSee({ owner: BOB }, demoted)).toBe(false);
    expect(canSee({ owner: ADMIN_OWNER }, demoted)).toBe(false);
  });

  it("the CLI token counts as admin — it is the lockout escape hatch", async () => {
    session({ email: ALICE, admins: [], cliToken: "cli-token-value" });
    expect((await getRequestIdentity()).isAdmin).toBe(true);
    expect(await getScopeFilter()).toBeNull();
  });

  it("a wrong CLI token grants nothing", async () => {
    session({ email: ALICE, admins: [], cliToken: "not-the-token" });
    expect((await getRequestIdentity()).isAdmin).toBe(false);
  });
});

describe("resolveDefaultOwner", () => {
  it("leaves resources unowned while scoping is off", async () => {
    session({ scope: false, email: ALICE });
    expect(await resolveDefaultOwner()).toBeNull();
  });

  it("stamps the creating SSO user", async () => {
    session({ email: ALICE });
    expect(await resolveDefaultOwner()).toBe(ALICE);
  });

  it("stamps an SSO admin with their own e-mail, not the sentinel", async () => {
    session({ email: ALICE, admins: [ALICE] });
    expect(await resolveDefaultOwner()).toBe(ALICE);
  });

  it("shares what the password login creates — @admin is opt-in, never a default", async () => {
    session({ email: null });
    expect(await resolveDefaultOwner()).toBeNull();
  });
});

describe("designated admins are tied to SSO-only", () => {
  it("grant admin while SSO is the only login", async () => {
    session({ email: ALICE, admins: [ALICE], authMode: "sso" });
    expect((await getRequestIdentity()).isAdmin).toBe(true);
  });

  it("go dormant once password login is back — the password is the admin again", async () => {
    for (const authMode of ["both", "password"]) {
      session({ email: ALICE, admins: [ALICE], authMode });
      expect((await getRequestIdentity()).isAdmin).toBe(false);
    }
  });

  it("are kept, not cleared, so switching back to SSO-only restores them", async () => {
    session({ email: ALICE, admins: [ALICE], authMode: "both" });
    expect((await getRequestIdentity()).isAdmin).toBe(false);
    session({ email: ALICE, admins: [ALICE], authMode: "oidc" });
    expect((await getRequestIdentity()).isAdmin).toBe(true);
  });

  it("never take the password login's own admin away", async () => {
    session({ email: null, admins: [], authMode: "password" });
    expect((await getRequestIdentity()).isAdmin).toBe(true);
  });
});

describe("ownerForCreate", () => {
  it("lets an admin choose any owner, including the sentinel", async () => {
    session({ email: null });
    expect(await ownerForCreate(BOB)).toBe(BOB);
    expect(await ownerForCreate("@admin")).toBe(ADMIN_OWNER);
    expect(await ownerForCreate("")).toBeNull();
  });

  it("ignores an owner sent by a scoped user, so one cannot be planted on someone else", async () => {
    session({ email: ALICE });
    // undefined defers to the repo, which stamps the caller's own identity.
    expect(await ownerForCreate(BOB)).toBeUndefined();
    expect(await ownerForCreate("@admin")).toBeUndefined();
  });

  it("defers to the repo when the field is absent", async () => {
    session({ email: null });
    expect(await ownerForCreate(undefined)).toBeUndefined();
  });

  it("lets an SSO admin choose, since the privilege is what matters", async () => {
    session({ email: ALICE, admins: [ALICE] });
    expect(await ownerForCreate(BOB)).toBe(BOB);
  });
});
