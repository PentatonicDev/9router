import { describe, expect, it, vi } from "vitest";

// The SSE→JSON path writes usage and request details; the assertions here are about
// the body shape, so those sinks are stubbed out.
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: async () => {},
  saveRequestDetail: async () => {},
}));

const { handleForcedSSEToJson } = await import("open-sse/handlers/chatCore/sseToJsonHandler.js");

const sse = (deltas) => new Response(
  deltas.map((d) => `data: ${JSON.stringify(d)}`).concat("data: [DONE]").join("\n") + "\n",
  { headers: { "content-type": "text/event-stream" } }
);

const chunks = [
  { id: "cc1", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "pensando no problema" } }] },
  { id: "cc1", choices: [{ index: 0, delta: { content: "a causa provavel e X" }, finish_reason: "stop" }] },
];

const call = (sourceFormat) => handleForcedSSEToJson({
  providerResponse: sse(chunks),
  sourceFormat,
  targetFormat: "openai",
  provider: "bedrock",
  model: "claude-sonnet-4-6",
  body: {},
  stream: false,
  requestStartTime: Date.now(),
  connectionId: "c1",
  appendLog: () => {},
  log: { info: () => {}, warn: () => {}, debug: () => {} },
  trackDone: () => {},
  errorContext: {},
  phases: {},
});

describe("reasoning survives the forced SSE→JSON path", () => {
  // A Claude client turns reasoning_content into a `thinking` block, so stripping it
  // here deleted extended thinking before it could be mapped. Measured on Bedrock:
  // a non-streaming Claude request came back with a text block only, while the same
  // request streamed a thinking block correctly.
  it("keeps it for a Claude client, as a thinking block", async () => {
    const { response } = await call("claude");
    const body = await response.json();
    const types = body.content.map((b) => b.type);
    expect(types).toContain("thinking");
    expect(body.content.find((b) => b.type === "thinking").thinking).toBe("pensando no problema");
  });

  it("still strips it for an OpenAI client, which has nowhere to put it", async () => {
    const { response } = await call("openai");
    const body = await response.json();
    expect(body.choices[0].message.reasoning_content).toBeUndefined();
    expect(body.choices[0].message.content).toBe("a causa provavel e X");
  });
});
