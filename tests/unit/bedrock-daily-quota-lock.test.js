// Bedrock answers the per-model daily token quota with a 429 "Too many tokens
// per day". Without a reset time the account got a short cooldown and the next
// request hit the same wall; the executor now reports the day rollover so the
// model lock (and combo fallback) lasts until then.
import { describe, it, expect } from "vitest";
import { BedrockExecutor, nextUtcMidnightMs } from "../../open-sse/executors/bedrock.js";

const exec = new BedrockExecutor();
const res = (status) => new Response("", { status });

describe("BedrockExecutor.parseError", () => {
  it("adds resetsAtMs at the next UTC midnight for the daily token quota 429", () => {
    const before = Date.now();
    const out = exec.parseError(res(429), JSON.stringify({ error: { message: "Too many tokens per day, please wait before trying again." } }));
    expect(out.status).toBe(429);
    expect(out.message).toMatch(/tokens per day/);
    expect(out.resetsAtMs).toBe(nextUtcMidnightMs(before));
    expect(out.resetsAtMs).toBeGreaterThan(before);
    expect(out.resetsAtMs - before).toBeLessThanOrEqual(24 * 3600_000);
    expect(new Date(out.resetsAtMs).toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it("leaves other 429s (per-minute throttling) without a reset time", () => {
    const out = exec.parseError(res(429), JSON.stringify({ error: { message: "Too many requests, please wait before trying again." } }));
    expect(out.resetsAtMs).toBeUndefined();
  });

  it("nextUtcMidnightMs rolls the date, not the month, at month end", () => {
    expect(new Date(nextUtcMidnightMs(Date.UTC(2026, 0, 31, 23, 59))).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});
