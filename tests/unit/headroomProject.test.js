import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getApiKeyOwner: async () => null }));
const { headroomProjectUrl } = await import("@/lib/auth/scopedSettings");

describe("headroomProjectUrl", () => {
  const BASE = "http://127.0.0.1:8787";

  it("routes a key to its own project path", () => {
    expect(headroomProjectUrl(BASE, "backend")).toBe(`${BASE}/p/backend`);
    expect(headroomProjectUrl(`${BASE}/`, "backend")).toBe(`${BASE}/p/backend`);
  });

  it("slugifies a name that would break the path", () => {
    expect(headroomProjectUrl(BASE, "gsouza@pentatonic.dev")).toBe(`${BASE}/p/gsouza-pentatonic.dev`);
    expect(headroomProjectUrl(BASE, "key do bob!")).toBe(`${BASE}/p/key-do-bob`);
    expect(headroomProjectUrl(BASE, "../../etc")).toBe(`${BASE}/p/etc`);
  });

  it("keeps an explicit project in the configured URL — that is the operator's choice", () => {
    expect(headroomProjectUrl(`${BASE}/p/fixo`, "outra")).toBe(`${BASE}/p/fixo`);
  });

  it("falls back to the plain URL when there is no usable name", () => {
    for (const name of [null, undefined, "", "   ", "!!!"]) {
      expect(headroomProjectUrl(BASE, name)).toBe(BASE);
    }
  });
});
