import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localDb = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => [{ provider: "vercel-ai-gateway", apiKey: "vk-test", isActive: true }]),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}),
  getProviderConnections: localDb.getProviderConnections,
}));
vi.mock("@/lib/auth/resourceScope", () => ({
  getScopeFilter: async () => ({}),
  scopeVisible: (rows) => rows,
}));

const { POST } = await import("@/app/api/providers/validate/route.js");

const call = (body) => POST(new Request("http://local/api/providers/validate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

let mockFetch;
beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

// Leaving a stubbed global behind leaks into every other test file sharing this
// worker: a file running next — or concurrently — that expects the real fetch, or
// whose own `restoreAllMocks` removes this stub mid-test, then makes a real
// network call and times out. Measured: unit/xai-oauth-service.test.js failed in
// the full suite and passed alone for exactly this reason.
afterEach(() => {
  vi.unstubAllGlobals();
});

const reply = (status, text = "") => ({ ok: status >= 200 && status < 300, status, text: async () => text });

describe("probeJev through the validate route (gateway provider)", () => {
  it("200 upstream -> valid, and the body is the calibrated one", async () => {
    mockFetch.mockResolvedValue(reply(200, JSON.stringify({ model: "typesafe-ai/jev", answers: {}, usage: { input_tokens: 271, output_tokens: 3 } })));
    const data = await (await call({ provider: "vercel-ai-gateway" })).json();
    expect(data.valid).toBe(true);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(opts.headers.Authorization).toBe("Bearer vk-test");
    expect(JSON.parse(opts.body)).toEqual({
      model: "typesafe-ai/jev",
      state: {},
      questions: { ping: { type: "noul", instructions: "Is this a ping?" } },
    });
  });

  it("401 upstream -> invalid, error blames the key and names it deterministic", async () => {
    mockFetch.mockResolvedValue(reply(401, JSON.stringify({ message: "Authentication failed", error_type: "authentication_error" })));
    const data = await (await call({ provider: "vercel-ai-gateway" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/rejected its own key/);
  });

  it("429 and 529 -> valid (auth passed)", async () => {
    for (const status of [429, 529]) {
      mockFetch.mockResolvedValue(reply(status));
      expect((await (await call({ provider: "vercel-ai-gateway" })).json()).valid).toBe(true);
    }
  });

  it("400 -> schema message, never an invalid-key message", async () => {
    mockFetch.mockResolvedValue(reply(400, JSON.stringify({ message: "questions: Invalid input: expected record, received array", error_type: "invalid_request" })));
    const data = await (await call({ provider: "vercel-ai-gateway" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/schema changed/);
    expect(data.error).not.toMatch(/rejected/);
  });

  it("503 -> says it is not a rejected key", async () => {
    mockFetch.mockResolvedValue(reply(503, "Service temporarily unavailable"));
    const data = await (await call({ provider: "vercel-ai-gateway" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/not a rejected key/);
  });

  it("timeout -> names the timeout", async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const data = await (await call({ provider: "vercel-ai-gateway" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/no answer from the decision route within 15s/);
  });

  it("no key on the request still reaches the probe (guard carve-out)", async () => {
    mockFetch.mockResolvedValue(reply(200));
    const res = await call({ provider: "vercel-ai-gateway" });
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).valid).toBe("boolean");
  });

  it("a non-decision provider without a key is still rejected by the guard", async () => {
    const res = await call({ provider: "openai" });
    expect(res.status).toBe(400);
  });
});

// The router config lives here rather than in its own file because these are the
// mocks it needs anyway. Backward compatibility matters: settings saved before
// the gateway became the provider carry `route` and no `provider`, and must keep
// working rather than silently resolving to nothing.
describe("decision router config", () => {
  it("fills the gateway and model for settings saved in the old shape", async () => {
    const { normalizeDecisionConfig, isDecisionAllowed } = await import("../../src/sse/services/decisionRouter.js");
    const migrated = normalizeDecisionConfig({ mode: "enforce", route: "vercel", models: ["my-combo"] });
    expect(migrated.provider).toBe("vercel-ai-gateway");
    expect(migrated.model).toBe("typesafe-ai/jev");
    expect(migrated.mode).toBe("enforce");
    expect(isDecisionAllowed(migrated, { comboName: "my-combo" })).toBe(true);
  });

  it("lets the provider and the model be replaced without touching anything else", async () => {
    const { normalizeDecisionConfig } = await import("../../src/sse/services/decisionRouter.js");
    const swapped = normalizeDecisionConfig({ provider: "openrouter", model: "typesafe/jev-1.13" });
    expect(swapped.provider).toBe("openrouter");
    expect(swapped.model).toBe("typesafe/jev-1.13");
  });

  it("lists the gateways that can serve a decision model", async () => {
    const { decisionProviders } = await import("../../src/sse/services/decisionRouter.js");
    const ids = decisionProviders().map((p) => p.id);
    expect(ids).toContain("vercel-ai-gateway");
    // The panel needs the default to prefill the model field.
    const vercel = decisionProviders().find((p) => p.id === "vercel-ai-gateway");
    expect(vercel.defaultModel).toBe("typesafe-ai/jev");
    expect(vercel.modelType).toBe("evaluation");
  });
});

describe("proving a key that has no connection yet", () => {
  // The Add-connection dialog validates a key it has not stored. Reading only from
  // the stored connection made a working Vercel key answer "no active connection"
  // — measured, and it left the provider impossible to add from the UI at all.
  it("uses the key from the body even though a stored connection exists", async () => {
    // No queued value here on purpose: the body key short-circuits the lookup, so
    // `getProviderConnections` is never called and a queued `mockResolvedValueOnce`
    // would leak into the next test.
    mockFetch.mockResolvedValue(reply(200, JSON.stringify({ model: "typesafe-ai/jev", answers: {}, usage: { input_tokens: 271, output_tokens: 1 } })));

    const data = await (await call({ provider: "vercel-ai-gateway", apiKey: "vk-from-dialog" })).json();

    expect(data.valid).toBe(true);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer vk-from-dialog");
  });

  it("still reads the stored connection when the body carries no key", async () => {
    mockFetch.mockResolvedValue(reply(200, JSON.stringify({ model: "typesafe-ai/jev", answers: {}, usage: { input_tokens: 271, output_tokens: 1 } })));

    const data = await (await call({ provider: "vercel-ai-gateway" })).json();

    expect(data.valid).toBe(true);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer vk-test");
  });
});
