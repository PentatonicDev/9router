// Regression: the providers dashboard page filters `models` (bedrock's live
// discovery, other providers' static catalog) to llm-only entries before
// rendering "Available Models". Bedrock discovery
// (open-sse/services/bedrockModels.js) puts `kind: "model"|"profile"` on every
// item — a different axis (invocation shape) than the generic `kind` meaning
// content type ("llm"/"embedding"/"tts"). Without the bedrock carve-out, every
// discovered model/profile is filtered out and "Available Models" renders
// empty right after a successful discovery + save.
import { describe, it, expect } from "vitest";
import { isLlmKindForProvider } from "@/shared/constants/models";

describe("isLlmKindForProvider", () => {
  it("keeps bedrock's discovered 'model' and 'profile' entries", () => {
    expect(isLlmKindForProvider({ id: "a", kind: "model" }, "bedrock")).toBe(true);
    expect(isLlmKindForProvider({ id: "b", kind: "profile" }, "bedrock")).toBe(true);
  });

  it("still excludes a genuinely non-llm kind for bedrock", () => {
    expect(isLlmKindForProvider({ id: "c", kind: "embedding" }, "bedrock")).toBe(false);
  });

  it("does not extend the 'model'/'profile' carve-out to other providers", () => {
    // Mutation guard: if the bedrock check were dropped (or `providerId` ignored),
    // this is the only assertion that would catch it — every other case here
    // also passes under plain `!k || k === "llm"`.
    expect(isLlmKindForProvider({ id: "d", kind: "profile" }, "openai")).toBe(false);
    expect(isLlmKindForProvider({ id: "e", kind: "model" }, "openai")).toBe(false);
  });

  it("keeps the generic llm/no-kind behavior for every provider", () => {
    expect(isLlmKindForProvider({ id: "f", kind: "llm" }, "openai")).toBe(true);
    expect(isLlmKindForProvider({ id: "g" }, "openai")).toBe(true);
    expect(isLlmKindForProvider({ id: "h" }, "bedrock")).toBe(true);
  });

  it("still excludes embedding/tts kinds for every provider", () => {
    expect(isLlmKindForProvider({ id: "i", kind: "embedding" }, "openai")).toBe(false);
    expect(isLlmKindForProvider({ id: "j", kind: "tts" }, "openai")).toBe(false);
  });
});
