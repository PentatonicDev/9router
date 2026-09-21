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

describe("resolveBedrockModelId — discovery-aware resolution (on-demand-only models)", () => {
  // Nova Micro: on-demand only, no cross-region profile. Discovery persisted
  // both the bare on-demand id (granted) and an unrelated "us." profile for
  // the same vendor — prepending the connection's "global." prefix produced
  // an invalid id ("global.amazon.nova-micro-v1:0") that Bedrock rejected.
  const novaMicroDiscovery = {
    inferenceProfilePrefix: "global.",
    discoveredModels: {
      items: [
        { id: "amazon.nova-micro-v1:0", kind: "model", access: "granted" },
        { id: "us.amazon.nova-micro-v1:0", kind: "profile" },
      ],
    },
  };

  it("returns a discovered on-demand id unchanged instead of prepending the connection prefix", () => {
    expect(resolveBedrockModelId("amazon.nova-micro-v1:0", novaMicroDiscovery)).toBe("amazon.nova-micro-v1:0");
  });

  it("prefixes a bare id whose prefixed profile is discovered", () => {
    const discovery = {
      inferenceProfilePrefix: "global.",
      discoveredModels: {
        items: [{ id: "global.anthropic.claude-3-haiku-20240307-v1:0", kind: "profile" }],
      },
    };
    expect(resolveBedrockModelId("anthropic.claude-3-haiku-20240307-v1:0", discovery))
      .toBe("global.anthropic.claude-3-haiku-20240307-v1:0");
  });

  it("falls through to the existing prefix rule when the id matches discovery neither bare nor prefixed", () => {
    const discovery = {
      inferenceProfilePrefix: "global.",
      discoveredModels: {
        items: [{ id: "amazon.nova-micro-v1:0", kind: "model", access: "granted" }],
      },
    };
    expect(resolveBedrockModelId("anthropic.claude-3-haiku-20240307-v1:0", discovery))
      .toBe("global.anthropic.claude-3-haiku-20240307-v1:0");
  });

  it("behaves exactly as before when providerSpecificData carries no discovery data", () => {
    expect(resolveBedrockModelId("amazon.nova-micro-v1:0", { inferenceProfilePrefix: "global." }))
      .toBe("global.amazon.nova-micro-v1:0");
  });

  // For every real vendor id, rule (2)'s `${prefix}${model}` match produces the
  // same string the existing fallback prefix rule already would — so it can't
  // be pinned down by a realistic vendor id. This synthetic id's first segment
  // ("ca") collides with a BEDROCK_INFERENCE_PROFILE_PREFIXES geo token, which
  // makes the OLD firstSegment check misfire (it would treat a bare id as
  // already-prefixed and wrongly return it unchanged). Only the discovery
  // match in rule (2), evaluated before that firstSegment check, resolves it
  // correctly — this is what actually distinguishes rule (2) from the fallback.
  it("resolves via discovered prefix+model match even when the bare id's first segment collides with a geo-prefix token", () => {
    const discovery = {
      inferenceProfilePrefix: "global.",
      discoveredModels: {
        items: [{ id: "global.ca.fake-vendor-model-v1:0", kind: "profile" }],
      },
    };
    expect(resolveBedrockModelId("ca.fake-vendor-model-v1:0", discovery))
      .toBe("global.ca.fake-vendor-model-v1:0");
  });
});
