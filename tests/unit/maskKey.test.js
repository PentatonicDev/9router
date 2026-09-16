import { describe, it, expect } from "vitest";
import { maskApiKey } from "@/lib/db/helpers/maskKey.js";

describe("maskApiKey", () => {
  it("never returns the raw key", () => {
    const key = "sk-84bc02f77f09e687-nqpu5e-d58a2697";
    expect(maskApiKey(key)).not.toBe(key);
    expect(maskApiKey(key)).toContain("***");
  });

  it("distinguishes keys that share the instance prefix", () => {
    // Every key issued by one instance carries the same machineId-derived head,
    // so a prefix-only mask labelled all of them identically and usage rows
    // were attributed to whichever key happened to match first.
    const a = maskApiKey("sk-84bc02f77f09e687-nqpu5e-d58a2697");
    const b = maskApiKey("sk-84bc02f77f09e687-abcdef-11112222");
    expect(a).not.toBe(b);
  });

  it("handles short and empty values without leaking them whole", () => {
    expect(maskApiKey("short")).toBe("s***");
    expect(maskApiKey("")).toBeNull();
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey(12345)).toBeNull();
  });
});
