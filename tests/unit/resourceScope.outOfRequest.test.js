import { describe, it, expect, vi } from "vitest";

// Repos also run outside a request (boot, background token refresh, CLI), where
// next/headers throws. Resolving an owner must degrade to "no identity" there —
// if it threw, every OAuth account creation on those paths would break.
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ scopeResourcesByUser: true }) }));
vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: async () => null }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "cli" }));
vi.mock("next/headers", () => ({
  cookies: async () => { throw new Error("`cookies` was called outside a request scope."); },
  headers: async () => { throw new Error("`headers` was called outside a request scope."); },
}));

const { getRequestIdentity, getScopeFilter } = await import("@/lib/auth/resourceScope");

describe("identity outside a request scope", () => {
  it("does not throw and reports no identity", async () => {
    await expect(getRequestIdentity()).resolves.toEqual({ isAdmin: false, owner: null });
  });

  it("yields a filter that still hides other users' resources", async () => {
    const filter = await getScopeFilter();
    expect(filter).toEqual({ owner: null });
  });
});
