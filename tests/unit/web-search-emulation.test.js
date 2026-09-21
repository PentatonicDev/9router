// Gateway-side web_search emulation (src/sse/services/webSearchEmulation.js):
// turns the inert client tool the translator produces from Anthropic's
// server-side web_search tool into an actually-executed search loop, then
// rebuilds the server_tool_use / web_search_tool_result blocks a Claude
// client expects — in both JSON and SSE form.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchForChat: vi.fn(),
}));
vi.mock("@/sse/services/webSearchRunner.js", () => ({ searchForChat: mocks.searchForChat }));

const { hasWebSearchServerTool, emulateWebSearch } = await import("@/sse/services/webSearchEmulation.js");

beforeEach(() => {
  vi.clearAllMocks();
});

function jsonResult(message) {
  return { success: true, response: new Response(JSON.stringify(message)) };
}

function baseBody(overrides = {}) {
  return {
    model: "claude/sonnet-4.6",
    stream: false,
    messages: [{ role: "user", content: "what's new today" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    ...overrides,
  };
}

async function readSSE(response) {
  const text = await response.text();
  const events = [];
  for (const raw of text.split("\n\n")) {
    if (!raw.trim()) continue;
    const eventLine = raw.split("\n").find((l) => l.startsWith("event:"));
    const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
    events.push({ type: eventLine?.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
  }
  return events;
}

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("hasWebSearchServerTool", () => {
  it("matches any web_search_* version", () => {
    expect(hasWebSearchServerTool({ tools: [{ type: "web_search_20260209" }] })).toBe(true);
    expect(hasWebSearchServerTool({ tools: [{ type: "web_search_20260318" }] })).toBe(true);
    expect(hasWebSearchServerTool({ tools: [{ type: "function", name: "web_search" }] })).toBe(false);
    expect(hasWebSearchServerTool({ tools: [] })).toBe(false);
    expect(hasWebSearchServerTool({})).toBe(false);
  });
});

describe("emulateWebSearch", () => {
  it("(a) passes the request through untouched when there is no web_search server tool", async () => {
    const callCore = vi.fn(async (b) => jsonResult({ id: "msg_1", content: [{ type: "text", text: "hi" }] }));
    const body = baseBody({ tools: [{ name: "some_other_tool", input_schema: {} }] });
    const result = await emulateWebSearch({ body, stream: false, provider: "bedrock", settings: {}, apiKey: null, callCore, log: console });
    expect(callCore).toHaveBeenCalledTimes(1);
    expect(callCore).toHaveBeenCalledWith({ ...body, stream: false });
    expect(result.success).toBe(true);
  });

  it("(b) runs one search then returns the final answer, non-stream", async () => {
    mocks.searchForChat.mockResolvedValueOnce({
      ok: true,
      provider: "brave",
      results: [{ title: "Result One", url: "https://example.com/1", snippet: "snippet text", published_at: "2026-09-20" }],
    });

    let call = 0;
    const callCore = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResult({
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "latest news" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      return jsonResult({
        id: "msg_2",
        content: [{ type: "text", text: "Here is what I found." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 15 },
      });
    });

    const result = await emulateWebSearch({ body: baseBody(), stream: false, provider: "bedrock", settings: {}, apiKey: null, callCore, log: console });
    expect(result.success).toBe(true);
    const message = await result.response.json();

    expect(message.content[0].type).toBe("server_tool_use");
    expect(message.content[0].name).toBe("web_search");
    expect(message.content[0].id).toMatch(/^srvtoolu-emu-[0-9a-f]{16}$/);
    expect(message.content[1].type).toBe("web_search_tool_result");
    expect(message.content[1].content[0].encrypted_content.startsWith("9r:")).toBe(true);
    expect(message.content[1].content[0].url).toBe("https://example.com/1");
    expect(message.content.at(-1)).toEqual({ type: "text", text: "Here is what I found." });
    expect(message.usage.server_tool_use).toEqual({ web_search_requests: 1 });

    // Second call carries the search results back to the model as a tool_result.
    const secondCallBody = callCore.mock.calls[1][0];
    const toolResultMsg = secondCallBody.messages.at(-1);
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].tool_use_id).toBe("toolu_1");
    expect(toolResultMsg.content[0].content).toContain("Result One");
  });

  it("(c) stream: the final JSON is replayed as Claude SSE with the synthetic blocks first, no extra upstream call", async () => {
    mocks.searchForChat.mockResolvedValueOnce({
      ok: true,
      provider: "brave",
      results: [{ title: "R", url: "https://x.test", snippet: "s", published_at: null }],
    });

    let call = 0;
    const callCore = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResult({
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } }],
          stop_reason: "tool_use",
        });
      }
      return jsonResult({ id: "msg_2", model: "m", content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } });
    });

    const result = await emulateWebSearch({ body: baseBody({ stream: true }), stream: true, provider: "bedrock", settings: {}, apiKey: null, callCore, log: console });
    expect(result.success).toBe(true);
    expect(callCore).toHaveBeenCalledTimes(2);
    expect(callCore.mock.calls.every(([b]) => b.stream === false)).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSSE(result.response);

    expect(events[0].type).toBe("message_start");
    expect(events[0].data.message.usage).toEqual({ input_tokens: 10, output_tokens: 0, server_tool_use: { web_search_requests: 1 } });
    expect(events[1].type).toBe("content_block_start");
    expect(events[1].data.content_block.type).toBe("server_tool_use");
    expect(events[1].data.index).toBe(0);
    expect(events[2].type).toBe("content_block_delta");
    expect(events[2].data.delta).toEqual({ type: "input_json_delta", partial_json: JSON.stringify({ query: "q" }) });
    expect(events[3].type).toBe("content_block_stop");
    expect(events[4].type).toBe("content_block_start");
    expect(events[4].data.content_block.type).toBe("web_search_tool_result");
    expect(events[4].data.index).toBe(1);
    expect(events[5].type).toBe("content_block_stop");

    const textStart = events.find((e) => e.type === "content_block_start" && e.data.content_block?.type === "text");
    expect(textStart.data.index).toBe(2);
    const textDelta = events.find((e) => e.type === "content_block_delta" && e.data.delta?.type === "text_delta");
    expect(textDelta.data).toMatchObject({ index: 2, delta: { text: "answer" } });

    const messageDelta = events.find((e) => e.type === "message_delta");
    expect(messageDelta.data.delta.stop_reason).toBe("end_turn");
    expect(messageDelta.data.usage).toEqual({ input_tokens: 10, output_tokens: 3, server_tool_use: { web_search_requests: 1 } });
    expect(events[events.length - 1].type).toBe("message_stop");
  });

  it("(d) a second search past max_uses gets max_uses_exceeded", async () => {
    mocks.searchForChat.mockResolvedValueOnce({
      ok: true,
      provider: "brave",
      results: [{ title: "R1", url: "https://x.test/1", snippet: "s1", published_at: null }],
    });

    let call = 0;
    const callCore = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResult({
          id: "msg_1",
          content: [
            { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q1" } },
            { type: "tool_use", id: "toolu_2", name: "web_search", input: { query: "q2" } },
          ],
          stop_reason: "tool_use",
        });
      }
      return jsonResult({ id: "msg_2", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    });

    const body = baseBody({ tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] });
    const result = await emulateWebSearch({ body, stream: false, provider: "bedrock", settings: {}, apiKey: null, callCore, log: console });
    const message = await result.response.json();

    expect(mocks.searchForChat).toHaveBeenCalledTimes(1);
    const resultBlocks = message.content.filter((b) => b.type === "web_search_tool_result");
    expect(resultBlocks[0].content[0].url).toBe("https://x.test/1");
    expect(resultBlocks[1].content).toEqual({ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" });
    expect(message.usage.server_tool_use).toEqual({ web_search_requests: 2 });
  });

  it("(e) a runner failure surfaces as unavailable and the model still gets an Error tool_result", async () => {
    mocks.searchForChat.mockResolvedValueOnce({ ok: false, status: 502, error: "upstream timeout" });

    let call = 0;
    const callCore = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResult({
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } }],
          stop_reason: "tool_use",
        });
      }
      return jsonResult({ id: "msg_2", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    });

    const result = await emulateWebSearch({ body: baseBody(), stream: false, provider: "bedrock", settings: {}, apiKey: null, callCore, log: console });
    const message = await result.response.json();

    const resultBlock = message.content.find((b) => b.type === "web_search_tool_result");
    expect(resultBlock.content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" });

    const secondCallBody = callCore.mock.calls[1][0];
    const toolResultMsg = secondCallBody.messages.at(-1);
    expect(toolResultMsg.content[0].content).toBe("Error: upstream timeout");
  });

  it("(f) a mixed turn (web_search + client tool_use) stops the loop and returns stop_reason tool_use", async () => {
    mocks.searchForChat.mockResolvedValueOnce({
      ok: true,
      provider: "brave",
      results: [{ title: "R", url: "https://x.test", snippet: "s", published_at: null }],
    });

    const callCore = vi.fn(async () => jsonResult({
      id: "msg_1",
      content: [
        { type: "text", text: "Let me check that and also read the file." },
        { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } },
        { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "a.txt" } },
      ],
      stop_reason: "tool_use",
    }));

    const result = await emulateWebSearch({ body: baseBody(), stream: false, provider: "bedrock", settings: {}, apiKey: null, callCore, log: console });
    expect(callCore).toHaveBeenCalledTimes(1);
    const message = await result.response.json();

    expect(message.stop_reason).toBe("tool_use");
    const types = message.content.map((b) => b.type);
    expect(types).toEqual(["text", "server_tool_use", "web_search_tool_result", "tool_use"]);
    const clientToolUse = message.content.find((b) => b.type === "tool_use");
    expect(clientToolUse.id).toBe("toolu_2");
    expect(clientToolUse.name).toBe("read_file");
  });
});
