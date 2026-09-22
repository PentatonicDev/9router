import { describe, expect, it } from "vitest";
import { getExecutor } from "open-sse/executors/index.js";

describe("an evaluation model goes to its own endpoint", () => {
  // A model marked as an evaluation model is not a language model: the chat endpoint
  // refuses it ("is an evaluation model, not a language model"), so routing it there
  // is a guaranteed 400. The path comes from the provider's systemoneConfig, resolved
  // against its own chat origin so it moves with the transport.
  it("routes TypeSafe's jev to the systemone path", () => {
    expect(getExecutor("vercel-ai-gateway").buildUrl("typesafe-ai/jev", false, 0, {}))
      .toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
  });

  it("leaves an ordinary model on the chat endpoint", () => {
    expect(getExecutor("vercel-ai-gateway").buildUrl("openai/gpt-5.4", false, 0, {}))
      .toContain("/v1/chat/completions");
  });

  it("does not divert a model from a provider that ships no evaluation path", () => {
    expect(getExecutor("openai").buildUrl("gpt-5.4", false, 0, {}))
      .toContain("/v1/chat/completions");
  });
});
