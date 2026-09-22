import { beforeEach, describe, expect, it, vi } from "vitest";

// The decision writes its usage and its detail; both sinks are recorded here.
const sinks = vi.hoisted(() => ({ usage: [], detail: [] }));
vi.mock("@/lib/db/index.js", () => ({ saveRequestUsage: async (e) => { sinks.usage.push(e); } }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestDetail: async (e) => { sinks.detail.push(e); } }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}),
  getProviderConnections: async () => [{ provider: "vercel-ai-gateway", apiKey: "vk", isActive: true, connectionId: "conn-1" }],
  getProviderConnectionById: async () => null,
}));
vi.mock("@/lib/auth/resourceScope", () => ({ getScopeFilter: async () => ({}), scopeVisible: (r) => r }));

const { decideComboModel, decideTool } = await import("../../src/sse/services/decisionRouter.js");

/** A jev that answers a model question: pick the second model, with deliberation. */
const answers = (pick) => ({
  model: { type: "choice", choice: pick, confidence: 0.99, probabilities: { [pick]: 0.99 } },
  needs_reasoning: { type: "noul", noul: 0.2 },
});

const withJev = (payload) => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
};

const config = { route: "vercel", model: "typesafe-ai/jev", timeoutMs: 1000, minConfidence: 0.7, switchConfidence: 0.85 };
const models = ["p/haiku", "p/sonnet"];
const target = { url: "https://gw.test/systemone", apiKey: "vk", provider: "vercel-ai-gateway", connectionId: "conn-1", callerApiKey: "sk-caller" };

beforeEach(() => {
  sinks.usage.length = 0;
  sinks.detail.length = 0;
  vi.unstubAllGlobals();
});

describe("a decision accounts for itself", () => {
  it("writes a usage row carrying the verdict, the connection and the caller's key", async () => {
    withJev({ model: "typesafe-ai/jev", answers: answers("p/sonnet"), usage: { input_tokens: 812, output_tokens: 12 } });

    await decideComboModel({ body: { messages: [{ role: "user", content: "oi" }] }, models, comboName: "c", config, target, log: {} });

    expect(sinks.usage).toHaveLength(1);
    const row = sinks.usage[0];
    expect(row.provider).toBe("vercel-ai-gateway");
    expect(row.endpoint).toBe("decision");
    // Without these the row reads as an unattributed "Local (No API key)" call.
    expect(row.connectionId).toBe("conn-1");
    expect(row.apiKey).toBe("sk-caller");
    // And the verdict is what makes the row explain itself.
    expect(row.meta).toMatchObject({ kind: "model", apply: true, reason: "clear", model: "p/sonnet", confidence: 0.99 });
  });

  it("writes a detail row of its own, so it reaches the request-details list", async () => {
    withJev({ model: "typesafe-ai/jev", answers: answers("p/sonnet"), usage: { input_tokens: 812, output_tokens: 12 } });

    await decideComboModel({ body: { messages: [{ role: "user", content: "oi" }] }, models, comboName: "c", config, target, log: {} });

    expect(sinks.detail).toHaveLength(1);
    const detail = sinks.detail[0];
    expect(detail.provider).toBe("vercel-ai-gateway");
    expect(detail.connectionId).toBe("conn-1");
    // ttft null, not 0: there is no stream to time, and 0 would read as measured.
    expect(detail.latency.ttft).toBeNull();
    expect(detail.decision.model).toMatchObject({ chosen: "p/sonnet", applied: true, reason: "clear" });
  });

  it("records nothing when the decision model does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await decideComboModel({ body: { messages: [{ role: "user", content: "oi" }] }, models, comboName: "c", config, target, log: {} });
    expect(sinks.usage).toHaveLength(0);
    expect(sinks.detail).toHaveLength(0);
  });
});

// Anthropic 400s with "Thinking mode does not support this tool_choice" when a tool
// is pinned while thinking is on. decideTool must read that off the real body and
// degrade the verdict to a hint, which writes no tool_choice at all.
describe("a thinking request never gets a pinned tool", () => {
  const toolAnswers = {
    tool: { type: "choice", choice: "Bash", confidence: 0.95, probabilities: { Bash: 0.95 } },
    needs_tool: { type: "noul", noul: 0.9 },
  };
  const toolBody = (extra = {}) => ({
    model: "claude-opus-5",
    messages: [{ role: "user", content: "run the tests" }],
    tools: [{ type: "function", function: { name: "Bash", description: "Run a command." } }],
    ...extra,
  });
  const config = { model: "typesafe-ai/jev", toolMode: "forced", minConfidence: 0.7, timeoutMs: 1000 };

  it("downgrades to a hint when the body carries an enabled thinking block", async () => {
    withJev({ model: "typesafe-ai/jev", answers: toolAnswers, usage: { input_tokens: 10, output_tokens: 5 } });
    const verdict = await decideTool({
      body: toolBody({ thinking: { type: "enabled", budget_tokens: 10000 } }),
      tools: [{ name: "Bash", description: "Run a command.", kind: "function" }],
      config, target, log: {},
    });
    expect(verdict).toMatchObject({ mode: "hint", tool: "Bash", reason: "thinking_blocks_tool_choice" });
  });

  it("still forces when thinking is explicitly disabled", async () => {
    withJev({ model: "typesafe-ai/jev", answers: toolAnswers, usage: { input_tokens: 10, output_tokens: 5 } });
    const verdict = await decideTool({
      body: toolBody({ thinking: { type: "disabled" } }),
      tools: [{ name: "Bash", description: "Run a command.", kind: "function" }],
      config, target, log: {},
    });
    expect(verdict).toMatchObject({ mode: "forced", tool: "Bash" });
  });

  it("still forces when thinking travels as reasoning_effort (no such restriction)", async () => {
    withJev({ model: "typesafe-ai/jev", answers: toolAnswers, usage: { input_tokens: 10, output_tokens: 5 } });
    const verdict = await decideTool({
      body: toolBody({ reasoning_effort: "high" }),
      tools: [{ name: "Bash", description: "Run a command.", kind: "function" }],
      config, target, log: {},
    });
    expect(verdict).toMatchObject({ mode: "forced", tool: "Bash" });
  });
});
