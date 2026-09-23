import { describe, expect, it, vi } from "vitest";

const credentials = vi.hoisted(() => vi.fn());
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: credentials }));
vi.mock("@/lib/db/index.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestDetail: vi.fn() }));

import { availableDecisionPool, decideComboModel, priceOf, resolveDecisionTarget } from "../../src/sse/services/decisionRouter.js";
import { cheapestWithinBand, resolveModelDecision } from "../../open-sse/decision/decide.js";

describe("decision pool availability", () => {
  it("binds the decision credential to the caller's allowed connection and owner", async () => {
    credentials.mockResolvedValueOnce({ apiKey: "vk", connectionId: "conn-1" });
    const target = await resolveDecisionTarget({ provider: "vercel-ai-gateway" }, {
      apiKey: "sk-caller", allowedConnectionIds: ["conn-1"], comboOwner: "owner-1", settings: { scopeResourcesByUser: true },
    });
    expect(target.connectionId).toBe("conn-1");
    expect(credentials).toHaveBeenCalledWith("vercel-ai-gateway", expect.any(Set), "decision:vercel-ai-gateway", expect.objectContaining({
      apiKey: "sk-caller", allowedConnectionIds: ["conn-1"], keyOwner: "owner-1", settings: { scopeResourcesByUser: true },
    }));
    credentials.mockReset();
  });

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

  // Combo-of-combos with partial availability: the tiers expand to models, only
  // the reachable ones become options, and the unreachable ones stay as the tail
  // the caller's fallback loop walks last. Asking over a model whose account is
  // rate-limited spends a verdict on a route that cannot serve the turn.
  it("asks only over the reachable members of a combo-of-combos and keeps the rest as the tail", async () => {
    credentials.mockImplementation(async (provider, _exclude, _model, options) => {
      if (options?.inspectOnly) {
        return {
          kiro: { available: true, subscription: false },
          claude: { allRateLimited: true },
          bedrock: { noActiveCredentials: true },
        }[provider] || { available: false };
      }
      return { apiKey: "vk", connectionId: "conn-1" };
    });

    const TIERS = {
      "tier-cheap": ["kr/claude-haiku-4.5", "br/global.anthropic.claude-opus-4-6-v1"],
      "tier-hard": ["cc/claude-opus-5", "kr/claude-opus-5"],
    };
    const { rankPool } = await import("../../src/sse/services/decisionRouter.js");
    const ranked = await rankPool(["tier-cheap", "tier-hard"], async (name) => TIERS[name] || null);
    // No tier name survives expansion, so every option carries a real price.
    expect(ranked.some((name) => !name.includes("/"))).toBe(false);

    const { pool, costOf } = await availableDecisionPool(ranked, { apiKey: "sk-caller" });
    const fallback = ranked.filter((name) => !pool.includes(name));
    // Only the Kiro pair is reachable; the rate-limited and credential-less ones are not.
    expect(pool).toEqual(["kr/claude-haiku-4.5", "kr/claude-opus-5"]);
    expect(fallback.sort()).toEqual(["br/global.anthropic.claude-opus-4-6-v1", "cc/claude-opus-5"]);

    let asked;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      asked = JSON.parse(init.body);
      return new Response(JSON.stringify({
        answers: {
          model: { type: "choice", choice: "kr/claude-opus-5", confidence: 0.95, probabilities: { "kr/claude-opus-5": 0.95, "kr/claude-haiku-4.5": 0.05 } },
          needs_reasoning: { type: "noul", noul: 0.9 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      const out = await decideComboModel({
        body: { messages: [{ role: "user", content: "race condition under load" }] },
        models: ["tier-cheap", "tier-hard"], ranked: pool, costOf, fallback,
        comboName: "nested", config: { model: "typesafe-ai/jev", timeoutMs: 500, minStrength: 0.35, switchStrength: 0.6 },
        target: { url: "https://gw.test/systemone", apiKey: "vk" }, log: {},
      });
      // The unreachable models were never offered as options.
      expect(Object.keys(asked.questions.model.criteria)).toEqual(pool);
      // Pick first, then the rest of the reachable pool, then the unreachable tail.
      expect(out.models).toEqual([
        "kr/claude-opus-5", "kr/claude-haiku-4.5",
        "br/global.anthropic.claude-opus-4-6-v1", "cc/claude-opus-5",
      ]);
    } finally {
      vi.unstubAllGlobals();
      credentials.mockReset();
    }
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
