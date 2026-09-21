// Emulated Anthropic web_search server tool (server_tool_use / web_search_tool_result)
// round-tripping through the Claude→OpenAI bridge. Both blocks live in the SAME assistant
// message on the Claude side; the OpenAI shape needs the tool result as a separate "tool"
// message right after the assistant message, before the next turn.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const T = (body) => translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "m", body, true, null, null);

function snippetToken(snippet, published_at) {
  return "9r:" + Buffer.from(JSON.stringify({ snippet, published_at })).toString("base64url");
}

describe("Claude → OpenAI: emulated web_search server tool", () => {
  it("converts server_tool_use + web_search_tool_result into tool_calls + a tool message, ordered before the next user turn", () => {
    const out = T({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search for that." },
            { type: "server_tool_use", id: "srvtoolu-emu-abc123", name: "web_search", input: { query: "9router release notes" } },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu-emu-abc123",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com/a",
                  title: "9Router Release Notes",
                  encrypted_content: snippetToken("Fixed the bedrock capability table.", "2026-09-01"),
                  page_age: "3 days ago",
                },
                {
                  type: "web_search_result",
                  url: "https://example.com/b",
                  title: "Opaque Anthropic Result",
                  encrypted_content: "EncryptedOpaqueBlobNot9rPrefixed==",
                },
              ],
            },
            { type: "text", text: "Here's what I found." },
          ],
        },
        { role: "user", content: "next" },
      ],
    });

    const messages = out.messages;
    expect(messages).toHaveLength(3);

    const [assistantMsg, toolMsg, userMsg] = messages;

    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toEqual([
      { type: "text", text: "Let me search for that." },
      { type: "text", text: "Here's what I found." },
    ]);
    expect(assistantMsg.tool_calls).toEqual([
      {
        id: "srvtoolu-emu-abc123",
        type: "function",
        function: { name: "web_search", arguments: JSON.stringify({ query: "9router release notes" }) },
      },
    ]);

    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("srvtoolu-emu-abc123");
    expect(toolMsg.content).toContain("1. 9Router Release Notes\nhttps://example.com/a");
    expect(toolMsg.content).toContain("3 days ago");
    expect(toolMsg.content).toContain("Fixed the bedrock capability table.");
    expect(toolMsg.content).toContain("2. Opaque Anthropic Result\nhttps://example.com/b");
    // Opaque (non-"9r:") encrypted_content must never be decoded into a snippet.
    expect(toolMsg.content).not.toContain("EncryptedOpaqueBlobNot9rPrefixed");

    expect(userMsg).toEqual({ role: "user", content: "next" });
  });

  it("renders a web_search_tool_result error object as an Error tool message", () => {
    const out = T({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_01xyz", name: "web_search", input: { query: "q" } },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_01xyz",
              content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
            },
          ],
        },
      ],
    });

    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("srvtoolu_01xyz");
    expect(toolMsg.content).toBe("Error: max_uses_exceeded");
  });

  it("renders an empty result array as 'No results.'", () => {
    const out = T({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu-emu-empty", name: "web_search", input: { query: "q" } },
            { type: "web_search_tool_result", tool_use_id: "srvtoolu-emu-empty", content: [] },
          ],
        },
      ],
    });

    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("No results.");
  });

  it("keeps text with citations and drops nothing else", () => {
    const out = T({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Per the docs, 9Router routes to 40+ providers.",
              citations: [{ type: "web_search_result_location", url: "https://example.com", title: "Docs" }],
            },
          ],
        },
      ],
    });

    expect(out.messages).toEqual([
      { role: "assistant", content: "Per the docs, 9Router routes to 40+ providers." },
    ]);
  });

  it("leaves plain TOOL_USE/TOOL_RESULT handling unchanged", () => {
    const out = T({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SP" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
        },
      ],
    });

    expect(out.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "SP" }) } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ]);
  });
});
