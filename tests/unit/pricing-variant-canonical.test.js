import { describe, it, expect } from "vitest";
import { canonicalPricingModel, getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("canonicalPricingModel", () => {
  it.each([
    ["claude-opus-5.5-thinking-agentic", "claude-opus-5-5"],
    ["claude-sonnet-5.5", "claude-sonnet-5-5"],
    ["gpt-5.5-high-fast", "gpt-5.5"],
    ["gpt-6-luna[1m]", "gpt-6-luna"],
    ["gpt-5.4-mini-xhigh", "gpt-5.4-mini"],
  ])("%s -> %s", (input, expected) => expect(canonicalPricingModel(input)).toBe(expected));

  it("keeps suffixes that name a distinct model", () => {
    for (const id of ["gpt-5.4-pro", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.3-codex-spark", "gpt-5.4-nano"]) {
      expect(canonicalPricingModel(id)).toBe(id);
    }
  });
});

describe("variant spellings bill at the base model", () => {
  it("prices Kiro's dotted 5.5 ids at Opus/Sonnet 5.5 rates, not the older-family pattern", () => {
    expect(getPricingForModel("kiro", "claude-opus-5.5-thinking")).toMatchObject({ input: 4, output: 20 });
    expect(getPricingForModel("kiro", "claude-sonnet-5.5-agentic")).toMatchObject({ input: 2, output: 10 });
  });

  it("prices a Codex [1m] variant like its base model", () => {
    expect(getPricingForModel("codex", "gpt-6-luna[1m]")).toEqual(getPricingForModel("codex", "gpt-6-luna"));
  });
});
