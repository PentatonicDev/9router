import { it, expect, describe } from "vitest";
import { resolveCriteria, MODEL_BRIEFS } from "../open-sse/decision/modelBriefs.js";

const POOL = [
  "cc/claude-opus-5", "cx/gpt-5.6-sol", "ocg/deepseek-flash",
  "br/global.anthropic.claude-opus-4-6-v1", "openrouter/z-ai/glm-5.3-flash",
  "cc/claude-sonnet-5", "cx/gpt-5.6-terra", "br/global.anthropic.claude-sonnet-4-6",
  "kr/claude-sonnet-4.5", "cc/claude-haiku-4-5-20251001", "cx/gpt-5.6-luna",
  "br/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "ocg/deepseek-chat", "ocg/deepseek-reasoner",
];

function resolve(entry) {
  const slash = entry.indexOf("/");
  return resolveCriteria({ provider: entry.slice(0, slash), model: entry.slice(slash + 1) });
}

describe("model briefs", () => {
  it("every pool model gets a task-oriented brief, never the raw-caps fallback", () => {
    for (const m of POOL) {
      const text = resolve(m);
      if (text.match(/^supports native reasoning,? /))
        throw new Error(`${m} got the raw-caps fallback: "${text}"`);
      if (!text.includes("Use for") && !text.includes("Use when") && !text.includes("Reserve for"))
        throw new Error(`${m} got no task-oriented brief: "${text}"`);
    }
  });

  it("derived briefs produce tier-appropriate text for unknown models", () => {
    const text = resolveCriteria({ provider: "test", model: "some-unknown-model-v2" });
    // Should get *something* from derivation or caps, not crash
    expect(text).toBeTruthy();
  });

  it("operator override takes precedence", () => {
    const text = resolveCriteria({
      provider: "cc", model: "claude-opus-5",
      briefs: { "cc/claude-opus-5": "Custom operator brief." },
    });
    expect(text).toBe("Custom operator brief.");
  });

  it("deepseek models get distinct briefs despite identical pricing", () => {
    const flash = resolve("ocg/deepseek-flash");
    const chat = resolve("ocg/deepseek-chat");
    const reasoner = resolve("ocg/deepseek-reasoner");
    expect(flash).not.toBe(chat);
    expect(chat).not.toBe(reasoner);
  });
});
