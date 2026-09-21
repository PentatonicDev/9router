/**
 * Unit tests for resolveBedrockModelId (open-sse/services/bedrockClient.js).
 *
 * Discovery (bedrockModels.js) surfaces inference-profile ids that already
 * carry a geo prefix ("us.anthropic...", "global.anthropic..."). Prepending a
 * connection's inferenceProfilePrefix unconditionally produced invalid
 * double-prefixed ids ("global.us.anthropic...") — Bedrock rejected these with
 * ValidationException "The provided model identifier is invalid."
 */
import { describe, it, expect } from "vitest";
import { resolveBedrockModelId } from "../../open-sse/services/bedrockClient.js";

describe("resolveBedrockModelId", () => {
  it("prepends the connection prefix to a bare model id", () => {
    expect(resolveBedrockModelId("anthropic.claude-3-haiku-20240307-v1:0", { inferenceProfilePrefix: "us." }))
      .toBe("us.anthropic.claude-3-haiku-20240307-v1:0");
  });

  it("leaves an already geo-prefixed id unchanged even with a different connection prefix", () => {
    expect(resolveBedrockModelId("us.anthropic.claude-3-haiku-20240307-v1:0", { inferenceProfilePrefix: "global." }))
      .toBe("us.anthropic.claude-3-haiku-20240307-v1:0");
  });

  it("leaves a global.-prefixed id unchanged even with a us. connection prefix", () => {
    expect(resolveBedrockModelId("global.anthropic.claude-3-haiku-20240307-v1:0", { inferenceProfilePrefix: "us." }))
      .toBe("global.anthropic.claude-3-haiku-20240307-v1:0");
  });

  it("leaves a full ARN unchanged", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-haiku-20240307-v1:0";
    expect(resolveBedrockModelId(arn, { inferenceProfilePrefix: "us." })).toBe(arn);
  });

  it("leaves the model id unchanged when no connection prefix is set", () => {
    expect(resolveBedrockModelId("anthropic.claude-3-haiku-20240307-v1:0", {})).toBe("anthropic.claude-3-haiku-20240307-v1:0");
  });
});
