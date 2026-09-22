import { it, expect } from "vitest";
import { resolveCriteria } from "../open-sse/decision/modelBriefs.js";
const POOL = ["cc/claude-opus-5","cx/gpt-5.6-sol","ocg/deepseek-flash",
  "br/global.anthropic.claude-opus-4-6-v1","openrouter/z-ai/glm-5.3-flash",
  "cc/claude-sonnet-5","cx/gpt-5.6-terra","br/global.anthropic.claude-sonnet-4-6",
  "kr/claude-sonnet-4.5","cc/claude-haiku-4-5-20251001","cx/gpt-5.6-luna",
  "br/global.anthropic.claude-haiku-4-5-20251001-v1:0"];
it("all 12 pool models get a curated brief, never the fallback", () => {
  for (const m of POOL) {
    const slash = m.indexOf("/");
    const text = resolveCriteria({ provider: m.slice(0, slash), model: m.slice(slash + 1) });
    if (text.startsWith("supports native reasoning")) throw new Error(`${m} got the bad fallback: "${text}"`);
    if (!text.includes("Use for") && !text.includes("Use when") && !text.includes("Reserve for"))
      throw new Error(`${m} got no curated brief: "${text}"`);
  }
});
