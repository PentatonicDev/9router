import { describe, expect, it, vi } from "vitest";

const credentials = vi.hoisted(() => vi.fn());
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: credentials }));
vi.mock("@/lib/db/index.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestDetail: vi.fn() }));

import { availableDecisionPool, decideComboModel, priceOf } from "../../src/sse/services/decisionRouter.js";
import { cheapestWithinBand, resolveModelDecision } from "../../open-sse/decision/decide.js";

describe("decision pool availability", () => {
  it("omits unavailable models, favors subscriptions over metered keys, and keeps free providers", async () => {
    credentials.mockImplementation(async (provider) => ({
      claude: { available: true, subscription: true },
      openai: { available: true, subscription: false },
      bedrock: { allRateLimited: true },
      "mimo-free": { available: true, free: true },
    })[provider]);
    const ranked = ["openai/gpt-5", "br/claude-opus-4-6-v1", "cc/claude-opus-5", "mimo-free/mimo-v2"];
    const { pool, costOf } = await availableDecisionPool(ranked, {
      apiKey: "sk-test", settings: {}, comboOwner: "owner", allowedConnectionIds: ["conn-1"],
    });

    expect(pool).toEqual(["cc/claude-opus-5", "mimo-free/mimo-v2", "openai/gpt-5"]);
    expect(costOf("cc/claude-opus-5")).toBe(0);
    expect(costOf("openai/gpt-5")).toBe(priceOf("openai/gpt-5"));
    expect(cheapestWithinBand("openai/gpt-5", {
      "openai/gpt-5": 0.55, "cc/claude-opus-5": 0.5,
    }, costOf)).toBe("cc/claude-opus-5");
    expect(credentials).toHaveBeenCalledWith("claude", null, "claude-opus-5", expect.objectContaining({
      apiKey: "sk-test", keyOwner: "owner", allowedConnectionIds: ["conn-1"], inspectOnly: true,
    }));

    let asked;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      asked = JSON.parse(init.body);
      return new Response(JSON.stringify({
        answers: {
          model: { type: "choice", choice: "cc/claude-opus-5", confidence: 0.95, probabilities: { "cc/claude-opus-5": 0.95 } },
          needs_reasoning: { type: "noul", noul: 0.9 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const decision = await decideComboModel({
      body: { messages: [{ role: "user", content: "Solve this problem" }] },
      models: ranked, ranked: pool, costOf,
      fallback: ranked.filter(name => !pool.includes(name)),
      comboName: "test", config: { model: "typesafe-ai/jev", timeoutMs: 500, minStrength: 0.35, switchStrength: 0.6 },
      target: { url: "https://test.invalid/systemone", apiKey: "test" }, log: {},
    });
    expect(Object.keys(asked.questions.model.criteria)).toEqual(pool);
    expect(decision.models).toEqual(["cc/claude-opus-5", "mimo-free/mimo-v2", "openai/gpt-5", "br/claude-opus-4-6-v1"]);
    vi.unstubAllGlobals();
    credentials.mockReset();
  });

  it("preserves the unchanged fallback pool if the decision call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    const models = ["openai/gpt-5", "cc/claude-opus-5", "br/claude-opus-4-6-v1"];
    const result = await decideComboModel({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models, ranked: models.slice(0, 2), fallback: models.slice(2), comboName: "test",
      config: { model: "typesafe-ai/jev", timeoutMs: 500 },
      target: { url: "https://test.invalid/systemone", apiKey: "test" }, log: {},
    });
    expect(result.models).toBe(models);
    vi.unstubAllGlobals();
  });

  it("does not confuse a flat subscription with a weak model on hard tasks", () => {
    const costly = "cc/claude-opus-5";
    const cheap = "ocg/deepseek-flash";
    const decision = resolveModelDecision({
      answers: {
        model: { type: "choice", choice: costly, confidence: 0.95, probabilities: { [costly]: 0.95, [cheap]: 0.05 } },
        needs_reasoning: { type: "noul", noul: 0.9 },
      },
      models: [costly, cheap], priceOf: name => name === costly ? 0 : 1,
      hardTaskPriceOf: name => name === costly ? 5 : 0.1,
      minStrength: 0.35, switchStrength: 0.6,
    });
    expect(decision).toMatchObject({ apply: true, model: costly });
  });

  it("does not offer unavailable models when no accounts qualify", async () => {
    credentials.mockResolvedValue({ noActiveCredentials: true });
    expect((await availableDecisionPool(["openai/gpt-5"])).pool).toEqual([]);
    credentials.mockReset();
  });
});
