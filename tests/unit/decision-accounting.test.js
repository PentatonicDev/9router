import { describe, expect, it } from "vitest";
import { buildDecisionDetail } from "open-sse/handlers/chatCore/requestDetail.js";

describe("buildDecisionDetail", () => {
  it("shapes the model verdict", () => {
    const out = buildDecisionDetail({ model: "br/opus", apply: true, reason: "clear", confidence: 0.9876, deliberation: 0.4321 }, null);
    expect(out).toEqual({ model: { chosen: "br/opus", applied: true, reason: "clear", confidence: 0.988, deliberation: 0.432 } });
  });

  it("shapes the tool verdict", () => {
    const out = buildDecisionDetail(null, { mode: "hint", tool: "Read", reason: null, confidence: 0.9, latencyMs: 412 });
    expect(out).toEqual({ tool: { mode: "hint", tool: "Read", reason: null, confidence: 0.9, latencyMs: 412 } });
  });

  it("carries both when a request had both", () => {
    const out = buildDecisionDetail({ model: "m", apply: false, reason: "low_confidence" }, { mode: "none" });
    expect(Object.keys(out).sort()).toEqual(["model", "tool"]);
    expect(out.model.applied).toBe(false);
  });

  // A request the router never considered must not carry an empty block — the detail
  // view reads presence to mean "a decision happened here".
  it("returns nothing when there was no decision", () => {
    expect(buildDecisionDetail(null, null)).toBeUndefined();
    expect(buildDecisionDetail(undefined, undefined)).toBeUndefined();
  });
});
