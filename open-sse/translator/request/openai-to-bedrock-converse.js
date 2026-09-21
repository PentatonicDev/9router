/**
 * OpenAI → Bedrock Converse request translator
 *
 * Converse/ConverseStream schema (verified against @aws-sdk/client-bedrock-runtime
 * dist-types, models_0.d.ts — see reader notes for line refs):
 *   { messages: [{role, content: ContentBlock[]}], system: [{text}]?,
 *     inferenceConfig: {maxTokens,temperature,topP,stopSequences}?,
 *     toolConfig: {tools:[{toolSpec:{name,description,inputSchema:{json}}}], toolChoice}? }
 *
 * Gotchas (confirmed from SDK types, not guessed):
 *  - ImageBlock.source.bytes wants raw Uint8Array, NOT a base64 string like
 *    OpenAI/Anthropic — must Buffer.from(b64, "base64").
 *  - ToolUseBlock.input on the request side is a parsed object (__DocumentType),
 *    not a JSON string — OpenAI's tool_calls[].function.arguments (a string) must
 *    be JSON.parse()d; malformed JSON is tolerated (falls back to {}) rather than
 *    thrown, since a client can echo back a truncated/garbled arguments string.
 *  - No topK in InferenceConfiguration — a client-sent top_k is silently dropped.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";
import { parseDataUri } from "../concerns/image.js";
import { stripBedrockGeoPrefix } from "../../providers/bedrockGeoPrefix.js";
import { uniqueToolName } from "../concerns/kiroConversation.js";

const MIME_TO_BEDROCK_IMAGE_FORMAT = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (typeof p?.text === "string" ? p.text : "")))
      .join("\n");
  }
  return String(content);
}

// OpenAI image_url/image/Claude-style image block -> Converse image content block.
// Returns null (block dropped) when the source isn't a decodable base64 data URI —
// Converse has no fetch-by-URL image source, unlike OpenAI's image_url.
function toBedrockImageBlock(part) {
  if (!part || typeof part !== "object") return null;

  let mimeType, base64;
  if (part.type === OPENAI_BLOCK.IMAGE_URL) {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const parsed = parseDataUri(url);
    if (!parsed) return null;
    ({ mimeType, base64 } = parsed);
  } else if (part.type === OPENAI_BLOCK.IMAGE && typeof part.image === "string") {
    const parsed = parseDataUri(part.image);
    if (!parsed) return null;
    mimeType = part.mimeType || parsed.mimeType;
    base64 = parsed.base64;
  } else if (part.type === CLAUDE_BLOCK.IMAGE && part.source?.type === "base64" && typeof part.source.data === "string") {
    mimeType = part.source.media_type || "image/png";
    base64 = part.source.data;
  } else {
    return null;
  }

  const format = MIME_TO_BEDROCK_IMAGE_FORMAT[mimeType?.toLowerCase()];
  if (!format) return null; // unsupported mime — drop rather than send a request Bedrock will reject

  return { image: { format, source: { bytes: Buffer.from(base64, "base64") } } };
}

function toContentBlocks(content) {
  if (content == null) return [{ text: "" }];
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];

  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
      blocks.push({ text: part.text });
      continue;
    }
    const image = toBedrockImageBlock(part);
    if (image) blocks.push(image);
    else if (typeof part.text === "string") blocks.push({ text: part.text });
  }
  return blocks.length ? blocks : [{ text: "" }];
}

// role:"tool" OpenAI message -> Converse toolResult content block. `status` mirrors
// the same is_error/status:"error" signal RTK already reads (open-sse/rtk/).
function toToolResultBlock(msg) {
  const isError = msg.is_error === true || msg.status === "error";
  return {
    toolResult: {
      toolUseId: msg.tool_call_id || "",
      content: [{ text: flattenText(msg.content) }],
      status: isError ? "error" : "success",
    },
  };
}

// Converse wants every toolResult of a turn inside ONE user message right after
// the assistant's toolUse blocks ("Expected toolResult blocks at messages.N"),
// while OpenAI carries one role:"tool" message per call — so same-role
// neighbours are merged into a single message.
function pushMerged(out, role, blocks) {
  const last = out[out.length - 1];
  if (last?.role === role) {
    if (last.content.length === 1 && last.content[0].text === "") last.content.length = 0;
    last.content.push(...blocks);
    return;
  }
  out.push({ role, content: blocks.length ? blocks : [{ text: "" }] });
}

function convertMessages(messages = [], toolNames = new Map()) {
  const out = [];
  const systemTexts = [];

  for (const m of messages) {
    if (!m) continue;

    if (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER) {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (m.role === ROLE.TOOL) {
      pushMerged(out, ROLE.USER, [toToolResultBlock(m)]);
      continue;
    }

    if (m.role === ROLE.ASSISTANT) {
      const blocks = toContentBlocks(m.content).filter((b) => !("text" in b) || b.text !== "");
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            toolUse: {
              toolUseId: tc.id || "",
              name: toolNames.get(fn.name) || fn.name || "",
              input: safeParseJson(fn.arguments),
            },
          });
        }
      }
      pushMerged(out, ROLE.ASSISTANT, blocks);
      continue;
    }

    pushMerged(out, ROLE.USER, toContentBlocks(m.content));
  }

  return { messages: out, system: systemTexts.length ? [{ text: systemTexts.join("\n\n") }] : undefined };
}

const BEDROCK_TOOL_NAME_MAX_LENGTH = 64;

// original name -> Converse-safe name ([a-zA-Z0-9_-]{1,64}); identity when already valid.
function buildToolNameMap(tools) {
  const map = new Map();
  const used = new Set();
  for (const [index, t] of (Array.isArray(tools) ? tools : []).entries()) {
    const name = t?.function?.name;
    if (typeof name !== "string" || !name || map.has(name)) continue;
    map.set(name, uniqueToolName(name, index, used, BEDROCK_TOOL_NAME_MAX_LENGTH));
  }
  return map;
}

function convertTools(tools, toolNames) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const toolSpecs = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
      // description is optional in ToolSpecification but must be non-empty when present
      // (400 "Member must have length greater than or equal to 1").
      const description = typeof t.function.description === "string" ? t.function.description.trim() : "";
      toolSpecs.push({
        toolSpec: {
          name: toolNames.get(t.function.name) || t.function.name,
          ...(description ? { description } : {}),
          inputSchema: { json: t.function.parameters || { type: "object", properties: {} } },
        },
      });
    }
  }
  return toolSpecs.length ? toolSpecs : undefined;
}

function convertToolChoice(choice, toolNames) {
  if (!choice || choice === "none") return undefined;
  if (choice === "auto") return { auto: {} };
  if (choice === "required" || choice === "any") return { any: {} };
  if (typeof choice === "object" && choice.type === OPENAI_BLOCK.FUNCTION && choice.function?.name) {
    return { tool: { name: toolNames.get(choice.function.name) || choice.function.name } };
  }
  return undefined;
}

const CACHE_POINT = { cachePoint: { type: "default" } };

// Prompt caching per vendor, measured live: Anthropic accepts a cachePoint in
// system, toolConfig.tools and message content; Nova rejects it inside tools
// (ValidationException); MiniMax/Llama/DeepSeek reject it anywhere
// (AccessDeniedException "unsupported model"). Below the model's minimum
// prefix size Bedrock simply ignores the checkpoint, so placing them is free.
function cacheVendor(model) {
  const bare = stripBedrockGeoPrefix(typeof model === "string" ? model : "");
  if (bare.startsWith("anthropic.")) return "anthropic";
  if (bare.startsWith("amazon.nova")) return "nova";
  return null;
}

// The client's own cache_control markers are lost in the OpenAI pivot, so the
// anchors are placed where a Claude client would: after the system prompt,
// after the tool definitions and after the latest message, so the next turn
// reads everything up to here (3 of the 4 checkpoints Bedrock allows).
function applyCachePoints(result, model) {
  const vendor = cacheVendor(model);
  if (!vendor) return;
  if (result.system) result.system.push({ ...CACHE_POINT });
  if (vendor === "anthropic" && result.toolConfig?.tools) result.toolConfig.tools.push({ ...CACHE_POINT });
  const last = result.messages[result.messages.length - 1];
  if (last) last.content.push({ ...CACHE_POINT });
}

export function openaiToBedrockConverseRequest(model, body, stream /* , credentials */) {
  const toolNames = buildToolNameMap(body.tools);
  const { messages, system } = convertMessages(body.messages, toolNames);

  const result = { messages };
  if (system) result.system = system;

  const inferenceConfig = {};
  if (body.max_tokens != null || body.max_output_tokens != null) {
    inferenceConfig.maxTokens = body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS;
  } else {
    inferenceConfig.maxTokens = DEFAULT_MAX_TOKENS;
  }
  if (body.temperature != null) inferenceConfig.temperature = body.temperature;
  if (body.top_p != null) inferenceConfig.topP = body.top_p;
  // Converse has no topK — dropped silently (matches other providers' handling of
  // fields their target format doesn't support).
  if (body.stop != null) {
    inferenceConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  result.inferenceConfig = inferenceConfig;

  const tools = convertTools(body.tools, toolNames);
  if (tools) {
    result.toolConfig = { tools };
    const toolChoice = convertToolChoice(body.tool_choice, toolNames);
    if (toolChoice) result.toolConfig.toolChoice = toolChoice;
  }

  // Reverse map (safe -> original) so tool calls come back under the client's names;
  // chatCore lifts `_toolNameMap` off the body before dispatch (same contract as Kiro).
  const restored = new Map();
  for (const [original, safe] of toolNames) if (original !== safe) restored.set(safe, original);
  if (restored.size) result._toolNameMap = restored;

  applyCachePoints(result, model);
  return result;
}

register(FORMATS.OPENAI, FORMATS.BEDROCK_CONVERSE, openaiToBedrockConverseRequest, null);
