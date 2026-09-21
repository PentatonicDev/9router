// reasoning_content on an OpenAI assistant turn has no Anthropic signature. It may only
// be replayed as a thinking block to upstreams that tolerate unsigned/sentinel thinking;
// native Anthropic verifies signatures, so there it must be dropped, never forged.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

const body = {
  messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: "a", reasoning_content: "my hidden reasoning" },
    { role: "user", content: "next" },
  ],
};
const T = (provider) => translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-sonnet-4-6", body, true, null, provider);
const assistantBlocks = (out) => out.messages.find((m) => m.role === "assistant").content;

describe("openai → claude: assistant reasoning_content", () => {
  it("native Anthropic: dropped (a forged signature would be rejected)", () => {
    const blocks = assistantBlocks(T("claude"));
    expect(blocks.some((b) => b.type === "thinking")).toBe(false);
    expect(JSON.stringify(blocks)).not.toContain("my hidden reasoning");
  });

  it("anthropic-compatible upstream: replayed under the sentinel signature", () => {
    const thinking = assistantBlocks(T("anthropic-compatible-x")).find((b) => b.type === "thinking");
    expect(thinking).toMatchObject({ thinking: "my hidden reasoning", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE });
  });

  it("deepseek: replayed unsigned (its endpoint does not verify)", () => {
    const thinking = assistantBlocks(T("deepseek")).find((b) => b.type === "thinking");
    expect(thinking).toMatchObject({ thinking: "my hidden reasoning" });
    expect(thinking.signature).toBeUndefined();
  });

  it("any other Claude-format upstream: dropped, and the marker never serializes", () => {
    const out = T("minimax");
    expect(JSON.stringify(out)).not.toContain("my hidden reasoning");
    expect(JSON.stringify(out)).not.toContain("syntheticThinking");
  });
});
