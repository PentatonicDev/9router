// Gateway-side emulation of Anthropic's server-side `web_search` tool for
// Claude-format clients (Claude Code) whose upstream provider cannot run
// server tools (Bedrock, every non-native-Anthropic provider). Today the
// translator turns the server tool into a plain function tool with an empty
// schema — the model calls it, nobody executes it, the client shows
// "Did 0 searches". This module runs the search itself, feeds the results
// back to the model in a loop, then rebuilds the Anthropic server-tool
// content blocks (server_tool_use + web_search_tool_result) the client
// expects, in both JSON and SSE form.
import { randomBytes } from "crypto";
import { searchForChat } from "./webSearchRunner.js";
import { CLAUDE_BLOCK } from "open-sse/translator/schema/blocks.js";

// Hard ceiling on search rounds regardless of max_uses — a runaway model that
// keeps calling web_search must not turn one client request into an unbounded
// number of upstream calls.
const MAX_ITERATIONS = 8;

const WEB_SEARCH_CLIENT_TOOL = {
  name: "web_search",
  description: "Search the web for current information. Returns titles, URLs, snippets and dates.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

export function hasWebSearchServerTool(body) {
  return Array.isArray(body?.tools) && body.tools.some((t) => typeof t?.type === "string" && t.type.startsWith("web_search_"));
}

function buildWorkingBody(body) {
  const serverTool = body.tools.find((t) => typeof t?.type === "string" && t.type.startsWith("web_search_"));
  const clientTools = body.tools.filter((t) => t !== serverTool);
  return {
    working: { ...body, tools: [...clientTools, WEB_SEARCH_CLIENT_TOOL], messages: [...(body.messages || [])] },
    maxUses: serverTool.max_uses ?? 5,
    allowedDomains: serverTool.allowed_domains ?? null,
    blockedDomains: serverTool.blocked_domains ?? null,
  };
}

function newSearchId() {
  // Hyphens are deliberate: Anthropic's own ids match ^srvtoolu_[a-zA-Z0-9_]+$,
  // so this id is dropped by the passthrough normalizer (CLAUDE_SERVER_TOOL_USE_ID
  // in open-sse/translator/formats/claude.js) if the conversation is later routed
  // to native Anthropic instead of poisoning that request.
  return `srvtoolu-emu-${randomBytes(8).toString("hex")}`;
}

async function runSearch({ call, recordedSoFar, maxUses, allowedDomains, blockedDomains, settings, apiKey, log }) {
  const id = newSearchId();
  const query = call.input?.query ?? "";
  if (recordedSoFar >= maxUses) {
    return { id, toolUseId: call.id, query, error: "max_uses_exceeded" };
  }
  const outcome = await searchForChat({ query, maxResults: 5, allowedDomains, blockedDomains, settings, apiKey, log });
  if (!outcome.ok) {
    return { id, toolUseId: call.id, query, error: outcome.error || "search failed" };
  }
  return { id, toolUseId: call.id, query, results: outcome.results };
}

function renderRecordText(record) {
  if (record.error) return `Error: ${record.error}`;
  return record.results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, r.url];
      if (r.published_at) lines.push(r.published_at);
      lines.push(r.snippet || "");
      return lines.join("\n");
    })
    .join("\n\n");
}

function toToolResultBlock(record) {
  return { type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: record.toolUseId, content: renderRecordText(record) };
}

function toBase64Url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

// Builds the pair of synthetic blocks (server_tool_use + web_search_tool_result)
// Anthropic's own API would have produced, for each search record, in order.
function buildSyntheticBlocks(records) {
  return records.flatMap((record) => {
    const useBlock = { type: CLAUDE_BLOCK.SERVER_TOOL_USE, id: record.id, name: "web_search", input: { query: record.query } };
    const resultBlock = record.error
      ? {
        type: CLAUDE_BLOCK.WEB_SEARCH_TOOL_RESULT,
        tool_use_id: record.id,
        content: { type: "web_search_tool_result_error", error_code: record.error === "max_uses_exceeded" ? "max_uses_exceeded" : "unavailable" },
      }
      : {
        type: CLAUDE_BLOCK.WEB_SEARCH_TOOL_RESULT,
        tool_use_id: record.id,
        content: record.results.map((r) => ({
          type: "web_search_result",
          url: r.url,
          title: r.title,
          encrypted_content: `9r:${toBase64Url({ snippet: r.snippet, published_at: r.published_at ?? null })}`,
          page_age: r.published_at ?? null,
        })),
      };
    return [useBlock, resultBlock];
  });
}

function jsonResponse(message) {
  return new Response(JSON.stringify(message), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ponytail: Anthropic defers tool execution when the model mixes a server
// tool call with a client tool call in the same turn — it returns stop_reason
// tool_use and lets the client run both. We instead run the web search
// eagerly here (simpler than threading a "pending server tool" state through
// the client round-trip) and hand back the result already resolved.
function buildMixedTurnMessage(message, turnRecords, totalSearchCount) {
  let i = 0;
  const content = [];
  for (const block of message.content || []) {
    if (block?.type === "tool_use" && block.name === "web_search") {
      content.push(...buildSyntheticBlocks([turnRecords[i++]]));
    } else {
      content.push(block);
    }
  }
  return {
    ...message,
    content,
    stop_reason: "tool_use",
    usage: { ...(message.usage || {}), server_tool_use: { web_search_requests: totalSearchCount } },
  };
}

// The loop already holds the final message as JSON; a streaming client gets it
// re-played as Claude SSE instead of paying a second upstream call for bytes.
function finalizeResponse({ records, stream, finalMessage }) {
  const message = {
    ...finalMessage,
    content: [...buildSyntheticBlocks(records), ...(finalMessage.content || [])],
    usage: { ...(finalMessage.usage || {}), server_tool_use: { web_search_requests: records.length } },
  };
  if (!stream) return { success: true, response: jsonResponse(message) };
  return {
    success: true,
    response: new Response(messageToSSE(message), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
    }),
  };
}

function formatEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// One content block as the start/delta/stop events Anthropic streams for it.
function blockToSSE(block, index) {
  const start = (content_block) => formatEvent("content_block_start", { type: "content_block_start", index, content_block });
  const delta = (d) => formatEvent("content_block_delta", { type: "content_block_delta", index, delta: d });
  const stop = formatEvent("content_block_stop", { type: "content_block_stop", index });
  switch (block?.type) {
    case "text":
      return start({ type: "text", text: "" }) + (block.text ? delta({ type: "text_delta", text: block.text }) : "") + stop;
    case "thinking":
      return start({ type: "thinking", thinking: "" })
        + (block.thinking ? delta({ type: "thinking_delta", thinking: block.thinking }) : "")
        + (block.signature ? delta({ type: "signature_delta", signature: block.signature }) : "")
        + stop;
    case "tool_use":
    case "server_tool_use":
      return start({ type: block.type, id: block.id, name: block.name, input: {} })
        + delta({ type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) })
        + stop;
    default:
      // web_search_tool_result, redacted_thinking, ...: Anthropic emits these whole.
      return start(block) + stop;
  }
}

function messageToSSE(message) {
  const { content = [], usage = {}, stop_reason = "end_turn", stop_sequence = null, ...rest } = message;
  const { output_tokens = 0, ...inputUsage } = usage;
  let out = formatEvent("message_start", {
    type: "message_start",
    message: { ...rest, type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: { ...inputUsage, output_tokens: 0 } },
  });
  content.forEach((block, i) => { out += blockToSSE(block, i); });
  out += formatEvent("message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence }, usage: { ...inputUsage, output_tokens } });
  out += formatEvent("message_stop", { type: "message_stop" });
  return out;
}

export async function emulateWebSearch({ body, stream, provider, settings, apiKey, callCore, log }) {
  if (!hasWebSearchServerTool(body)) {
    return callCore({ ...body, stream });
  }

  const { working, maxUses, allowedDomains, blockedDomains } = buildWorkingBody(body);
  const records = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const probe = await callCore({ ...working, stream: false });
    if (!probe.success) return probe;

    const message = await probe.response.json();
    const content = Array.isArray(message.content) ? message.content : [];
    const webSearchCalls = content.filter((b) => b?.type === "tool_use" && b.name === "web_search");

    if (webSearchCalls.length === 0) {
      return finalizeResponse({ records, stream, finalMessage: message });
    }

    const clientToolUses = content.filter((b) => b?.type === "tool_use" && b.name !== "web_search");
    const turnRecords = [];
    for (const call of webSearchCalls) {
      turnRecords.push(await runSearch({
        call,
        recordedSoFar: records.length + turnRecords.length,
        maxUses, allowedDomains, blockedDomains, settings, apiKey, log,
      }));
    }
    records.push(...turnRecords);

    if (clientToolUses.length > 0) {
      return { success: true, response: jsonResponse(buildMixedTurnMessage(message, turnRecords, records.length)) };
    }

    working.messages = [
      ...working.messages,
      { role: "assistant", content },
      { role: "user", content: turnRecords.map(toToolResultBlock) },
    ];
  }

  // ponytail: hard cap reached — deliver whatever the model says on this last
  // probe rather than looping forever on a model that never stops searching.
  const probe = await callCore({ ...working, stream: false });
  if (!probe.success) return probe;
  const finalMessage = await probe.response.json();
  return finalizeResponse({ records, stream, finalMessage });
}
