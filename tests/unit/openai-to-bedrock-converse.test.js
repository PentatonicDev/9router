/**
 * Unit tests for open-sse/translator/request/openai-to-bedrock-converse.js
 */
import { describe, it, expect } from "vitest";
import { openaiToBedrockConverseRequest } from "../../open-sse/translator/request/openai-to-bedrock-converse.js";

describe("openai-to-bedrock-converse — messages/system", () => {
  it("pulls system messages out into a top-level system array", () => {
    const result = openaiToBedrockConverseRequest("m", {
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
    }, true);
    expect(result.system).toEqual([{ text: "Be terse." }]);
    expect(result.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
  });
});

describe("openai-to-bedrock-converse — images are raw bytes, not a base64 string", () => {
  it("decodes a base64 data URI into a Uint8Array/Buffer under content[].image.source.bytes", () => {
    const base64 = Buffer.from("fake-png-bytes").toString("base64");
    const result = openaiToBedrockConverseRequest("m", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
    }, true);

    const blocks = result.messages[0].content;
    expect(blocks[0]).toEqual({ text: "what is this?" });
    expect(blocks[1].image.format).toBe("png");
    // This is the exact gotcha called out in the plan: Converse wants raw bytes,
    // NOT the base64 string OpenAI/Anthropic both use. A regression here silently
    // sends a garbled image with no error from Bedrock.
    expect(blocks[1].image.source.bytes).toBeInstanceOf(Uint8Array);
    expect(typeof blocks[1].image.source.bytes).not.toBe("string");
    expect(Buffer.from(blocks[1].image.source.bytes).toString()).toBe("fake-png-bytes");
  });

  it("drops an unsupported image mime type rather than sending a request Bedrock would reject", () => {
    const base64 = Buffer.from("x").toString("base64");
    const result = openaiToBedrockConverseRequest("m", {
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: `data:image/bmp;base64,${base64}` } }],
      }],
    }, true);
    expect(result.messages[0].content).toEqual([{ text: "" }]);
  });
});

describe("openai-to-bedrock-converse — tool round trip (BUG #7)", () => {
  it("JSON.parses tool_calls[].function.arguments into toolUse.input (object, not string)", () => {
    const result = openaiToBedrockConverseRequest("m", {
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SP"}' } }],
      }],
    }, true);
    const toolUse = result.messages[0].content.find((b) => b.toolUse)?.toolUse;
    expect(toolUse.input).toEqual({ city: "SP" });
    expect(typeof toolUse.input).toBe("object");
  });

  it("tolerates malformed JSON arguments instead of throwing", () => {
    expect(() => openaiToBedrockConverseRequest("m", {
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{not valid json" } }],
      }],
    }, true)).not.toThrow();

    const result = openaiToBedrockConverseRequest("m", {
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{not valid json" } }],
      }],
    }, true);
    const toolUse = result.messages[0].content.find((b) => b.toolUse)?.toolUse;
    expect(toolUse.input).toEqual({});
  });

  it("maps a role:tool message to a user-turn toolResult block, marking errors via status", () => {
    const ok = openaiToBedrockConverseRequest("m", {
      messages: [{ role: "tool", tool_call_id: "call_1", content: "72F" }],
    }, true);
    expect(ok.messages[0]).toEqual({
      role: "user",
      content: [{ toolResult: { toolUseId: "call_1", content: [{ text: "72F" }], status: "success" } }],
    });

    const err = openaiToBedrockConverseRequest("m", {
      messages: [{ role: "tool", tool_call_id: "call_1", content: "boom", is_error: true }],
    }, true);
    expect(err.messages[0].content[0].toolResult.status).toBe("error");
  });
});

describe("openai-to-bedrock-converse — inference config", () => {
  it("maps max_tokens/temperature/top_p/stop, drops unsupported top_k silently", () => {
    const result = openaiToBedrockConverseRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512, temperature: 0.7, top_p: 0.9, top_k: 40, stop: ["END"],
    }, true);
    expect(result.inferenceConfig).toEqual({ maxTokens: 512, temperature: 0.7, topP: 0.9, stopSequences: ["END"] });
    expect(result.inferenceConfig.topK).toBeUndefined();
  });
});

describe("openai-to-bedrock-converse — tools", () => {
  it("converts OpenAI function tools to toolConfig.tools[].toolSpec", () => {
    const result = openaiToBedrockConverseRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } }],
      tool_choice: "auto",
    }, true);
    expect(result.toolConfig.tools).toEqual([{
      toolSpec: { name: "get_weather", description: "d", inputSchema: { json: { type: "object" } } },
    }]);
    expect(result.toolConfig.toolChoice).toEqual({ auto: {} });
  });
});
