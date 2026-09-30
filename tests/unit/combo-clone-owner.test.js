// POST /api/combos checks name uniqueness against the owner the combo will land
// on (clone relies on it: same name + same owner blocked, other owner allowed).
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: [],
  createCombo: vi.fn(async (data) => ({ id: "new", ...data })),
  getRequestIdentity: vi.fn(async () => ({ isAdmin: true, owner: "@admin" })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getCombos: vi.fn(async () => mocks.store),
  createCombo: mocks.createCombo,
  getComboByName: vi.fn(async (name, owner) =>
    mocks.store.find((c) => c.name === name && c.owner === owner)
    ?? mocks.store.find((c) => c.name === name && c.owner === null) ?? null),
}));
vi.mock("@/lib/db/repos/hiddenCombosRepo.js", () => ({ getHiddenComboNames: vi.fn(async () => []) }));
vi.mock("@/lib/auth/resourceScope", () => ({
  getRequestIdentity: mocks.getRequestIdentity,
  getScopeFilter: vi.fn(async () => null),
  ownerForCreate: async (o) => (o === undefined ? undefined : o),
  resolveDefaultOwner: async () => null,
  scopeVisible: (rows) => rows,
}));

const post = async (body) => {
  const { POST } = await import("@/app/api/combos/route.js");
  return POST(new Request("http://localhost/api/combos", { method: "POST", body: JSON.stringify(body) }));
};

describe("POST /api/combos: name clash is per target owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store = [{ id: "a", name: "fast", owner: "@admin" }, { id: "b", name: "fast", owner: "bob@x.com" }];
  });

  it("blocks same name + same owner", async () => {
    expect((await post({ name: "fast", owner: "bob@x.com" })).status).toBe(400);
    expect(mocks.createCombo).not.toHaveBeenCalled();
  });

  it("allows same name under another owner", async () => {
    const res = await post({ name: "fast", owner: "ann@x.com", models: ["openai/gpt-5"] });
    expect(res.status).toBe(201);
    expect(mocks.createCombo).toHaveBeenCalledWith(expect.objectContaining({ owner: "ann@x.com" }));
  });

  it("allows a different name under the same owner", async () => {
    expect((await post({ name: "fast-copy", owner: "bob@x.com" })).status).toBe(201);
  });
});
