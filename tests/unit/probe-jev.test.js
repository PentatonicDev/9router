import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}),
  getProviderConnections: async () => [{ provider: "vercel-ai-gateway", apiKey: "vk-test", isActive: true }],
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

const reply = (status, text = "") => ({ ok: status >= 200 && status < 300, status, text: async () => text });

describe("probeJev through the validate route", () => {
  it("200 upstream -> valid, and the body is the calibrated one", async () => {
    mockFetch.mockResolvedValue(reply(200, JSON.stringify({ model: "typesafe-ai/jev", answers: {}, usage: { input_tokens: 271, output_tokens: 3 } })));
    const data = await (await call({ provider: "jev" })).json();
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
    const data = await (await call({ provider: "jev" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/rejected the vercel-ai-gateway key/);
  });

  it("429 and 529 -> valid (auth passed)", async () => {
    for (const status of [429, 529]) {
      mockFetch.mockResolvedValue(reply(status));
      expect((await (await call({ provider: "jev" })).json()).valid).toBe(true);
    }
  });

  it("400 -> schema message, never an invalid-key message", async () => {
    mockFetch.mockResolvedValue(reply(400, JSON.stringify({ message: "questions: Invalid input: expected record, received array", error_type: "invalid_request" })));
    const data = await (await call({ provider: "jev" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/schema changed/);
    expect(data.error).not.toMatch(/rejected/);
  });

  it("503 -> says it is not a rejected key", async () => {
    mockFetch.mockResolvedValue(reply(503, "Service temporarily unavailable"));
    const data = await (await call({ provider: "jev" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/not a rejected key/);
  });

  it("timeout -> names the timeout", async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const data = await (await call({ provider: "jev" })).json();
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/no answer within 15s/);
  });

  it("no key on the request still reaches the probe (guard carve-out)", async () => {
    mockFetch.mockResolvedValue(reply(200));
    const res = await call({ provider: "jev" });
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).valid).toBe("boolean");
  });

  it("a non-decision provider without a key is still rejected by the guard", async () => {
    const res = await call({ provider: "openai" });
    expect(res.status).toBe(400);
  });
});
