import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { scopeResourcesByUser: true, providerOverrides: {} },
  identity: { isAdmin: false, owner: "person@example.com" },
  updateSettings: vi.fn(),
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }) },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => mocks.settings), updateSettings: mocks.updateSettings,
}));
vi.mock("@/lib/auth/resourceScope", () => ({
  getRequestIdentity: vi.fn(async () => mocks.identity),
  isScopeEnabled: (settings) => settings.scopeResourcesByUser === true,
}));

const { PUT } = await import("@/app/api/providers/[id]/overrides/route.js");
const put = (body) => PUT(new Request("http://localhost/api/providers/codex/overrides", {
  method: "PUT", body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "codex" }) });

describe("provider header overrides are global settings", () => {
  it("rejects a scoped non-admin", async () => {
    mocks.settings = { scopeResourcesByUser: true, providerOverrides: {} };
    mocks.identity = { isAdmin: false, owner: "person@example.com" };
    mocks.updateSettings.mockClear();
    expect((await put({ headers: { "X-Trace": "x" } })).status).toBe(403);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
  it("allows admin and rejects a protected header", async () => {
    mocks.identity = { isAdmin: true, owner: "@admin" };
    expect((await put({ headers: { Authorization: "Bearer wrong" } })).status).toBe(400);
    expect((await put({ headers: { "X-Trace": "x" } })).status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalled();
  });
});
