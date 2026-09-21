// Converse rejects a turn whose toolResults are spread over several user
// messages ("Expected toolResult blocks at messages.N.content for the following
// Ids"), and prompt caching only happens when cachePoint blocks are present —
// the client's cache_control never survives the OpenAI pivot.
import { describe, it, expect } from "vitest";
import { openaiToBedrockConverseRequest } from "../../open-sse/translator/request/openai-to-bedrock-converse.js";
import { injectSystemPrompt } from "../../open-sse/rtk/systemInject.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const CP = { cachePoint: { type: "default" } };
const SONNET = "global.anthropic.claude-sonnet-4-6";
const tools = [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }];

function agenticTurn(n) {
  const calls = Array.from({ length: n }, (_, i) => ({ id: `tooluse_${i}`, type: "function", function: { name: "noop", arguments: "{}" } }));
  return [
    { role: "user", content: "run" },
    { role: "assistant", content: null, tool_calls: calls },
    ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: `r${c.id}` })),
  ];
}

describe("openai-to-bedrock-converse — tool results of one turn share a user message", () => {
  it("merges 5 role:tool messages into one user message with 5 toolResult blocks", () => {
    const out = openaiToBedrockConverseRequest("m", { messages: agenticTurn(5), tools }, true);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const results = out.messages[2].content.filter((b) => b.toolResult);
    expect(results.map((b) => b.toolResult.toolUseId)).toEqual(["tooluse_0", "tooluse_1", "tooluse_2", "tooluse_3", "tooluse_4"]);
  });

  it("keeps a user text that follows the tool results in the same message, after them", () => {
    const out = openaiToBedrockConverseRequest("m", { messages: [...agenticTurn(2), { role: "user", content: "and now?" }] }, true);
    expect(out.messages).toHaveLength(3);
    const blocks = out.messages[2].content;
    expect(blocks.slice(0, 2).every((b) => b.toolResult)).toBe(true);
    expect(blocks[2]).toEqual({ text: "and now?" });
  });

  it("drops the empty placeholder when merging into an empty user message", () => {
    const out = openaiToBedrockConverseRequest("m", { messages: [{ role: "user", content: "" }, { role: "user", content: "hi" }] }, true);
    expect(out.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
  });
});

describe("openai-to-bedrock-converse — cache points", () => {
  it("anthropic: after system, after tools and after the last message", () => {
    const out = openaiToBedrockConverseRequest(SONNET, { messages: [{ role: "system", content: "sys" }, ...agenticTurn(1)], tools }, true);
    expect(out.system).toEqual([{ text: "sys" }, CP]);
    expect(out.toolConfig.tools[out.toolConfig.tools.length - 1]).toEqual(CP);
    const last = out.messages[out.messages.length - 1];
    expect(last.content[last.content.length - 1]).toEqual(CP);
    expect(out.messages.slice(0, -1).some((m) => m.content.some((b) => b.cachePoint))).toBe(false);
  });

  it("nova: system and last message only, never inside tools", () => {
    const out = openaiToBedrockConverseRequest("us.amazon.nova-pro-v1:0", { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], tools }, true);
    expect(out.system[1]).toEqual(CP);
    expect(out.toolConfig.tools.some((t) => t.cachePoint)).toBe(false);
    expect(out.messages[0].content[1]).toEqual(CP);
  });

  it("other vendors get no cache point at all", () => {
    for (const id of ["minimax.minimax-m2", "us.meta.llama3-1-8b-instruct-v1:0", "deepseek.v3.2", "m"]) {
      const out = openaiToBedrockConverseRequest(id, { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], tools }, true);
      expect(JSON.stringify(out)).not.toContain("cachePoint");
    }
  });

  it("system-prompt injection lands inside the cached prefix, before the trailing cachePoint", () => {
    const out = openaiToBedrockConverseRequest(SONNET, { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] }, true);
    injectSystemPrompt(out, FORMATS.BEDROCK_CONVERSE, "CAVEMAN");
    expect(out.system).toEqual([{ text: "sys" }, { text: "CAVEMAN" }, CP]);
  });
});
