// A combo listed in /v1/models used to carry no token limits, so clients that
// size their context from the catalog (Hermes logs "Could not detect context
// length ... defaulting to 256,000") guessed. The limits follow the member a
// request would reach now.
import { describe, it, expect } from "vitest";
import { comboCurrentModel, comboContextLimits } from "../../src/lib/comboContext.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const future = new Date(Date.now() + 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();
const combo = { name: "claude-opus-5", models: ["cc/claude-opus-5", "cx/gpt-5.6-sol(high)"] };

describe("comboCurrentModel", () => {
  it("picks the first member whose provider has an active, unlocked connection", () => {
    const conns = [{ provider: "claude", isActive: true }, { provider: "codex", isActive: true }];
    expect(comboCurrentModel(combo, conns)).toEqual({ providerId: "claude", modelId: "claude-opus-5" });
  });

  it("skips a member whose only connection is locked for that model, and strips the thinking suffix", () => {
    const conns = [{ provider: "claude", isActive: true, "modelLock_claude-opus-5": future }, { provider: "codex", isActive: true }];
    expect(comboCurrentModel(combo, conns)).toEqual({ providerId: "codex", modelId: "gpt-5.6-sol" });
  });

  it("an expired lock or a disabled connection is treated correctly", () => {
    expect(comboCurrentModel(combo, [{ provider: "claude", isActive: true, "modelLock_claude-opus-5": past }]).providerId).toBe("claude");
    expect(comboCurrentModel(combo, [{ provider: "claude", isActive: false }, { provider: "codex", isActive: true }]).providerId).toBe("codex");
  });

  it("falls back to the first member when nothing is reachable, and null for an empty combo", () => {
    expect(comboCurrentModel(combo, []).providerId).toBe("claude");
    expect(comboCurrentModel({ models: [] }, [])).toBeNull();
  });
});

describe("comboContextLimits", () => {
  it("reports the current member's context window and max output", () => {
    const conns = [{ provider: "codex", isActive: true }];
    const limits = comboContextLimits(combo, conns);
    const caps = getCapabilitiesForModel("codex", "gpt-5.6-sol");
    expect(limits).toMatchObject({ providerId: "codex", modelId: "gpt-5.6-sol", contextWindow: caps.contextWindow, maxOutput: caps.maxOutput });
    expect(limits.contextWindow).toBeGreaterThan(0);
  });

  it("resolves a combo-of-combos by descending into the first sub-combo", () => {
    const opus = { name: "claude-opus-5", models: ["cc/claude-opus-5", "cx/gpt-5.6-sol(high)"] };
    const sonnet = { name: "claude-sonnet-5", models: ["cc/claude-sonnet-5"] };
    const auto = { name: "claude-auto", models: ["claude-opus-5", "claude-sonnet-5"] };
    const allCombos = [opus, sonnet, auto];
    const limits = comboContextLimits(auto, [], allCombos);
    expect(limits).not.toBeNull();
    expect(limits.contextWindow).toBe(getCapabilitiesForModel("claude", "claude-opus-5").contextWindow);
  });

  it("returns null for a combo of bare names when no allCombos is provided (old callers)", () => {
    const auto = { name: "claude-auto", models: ["claude-opus-5", "claude-sonnet-5"] };
    expect(comboContextLimits(auto, [])).toBeNull();
  });
});
