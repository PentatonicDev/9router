import { describe, it, expect } from "vitest";
import { summarizeDiscoveryItems } from "@/shared/utils/bedrockDiscovery";

describe("summarizeDiscoveryItems", () => {
  it("counts models, profiles and granted access, with correct pluralization", () => {
    const items = [
      { id: "a", kind: "model", access: "granted" },
      { id: "b", kind: "model", access: "denied" },
      { id: "c", kind: "profile", access: "granted" },
      { id: "d", kind: "profile", access: "unknown" },
    ];
    expect(summarizeDiscoveryItems(items)).toBe("2 models, 2 profiles · 2 with access granted");
  });

  it("singularizes counts of exactly 1", () => {
    const items = [{ id: "a", kind: "model", access: "granted" }];
    expect(summarizeDiscoveryItems(items)).toBe("1 model, 0 profiles · 1 with access granted");
  });

  it("handles empty/missing items without throwing", () => {
    expect(summarizeDiscoveryItems([])).toBe("0 models, 0 profiles · 0 with access granted");
    expect(summarizeDiscoveryItems(undefined)).toBe("0 models, 0 profiles · 0 with access granted");
  });
});
