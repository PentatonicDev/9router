import { OPENAI_BLOCK } from "../schema/index.js";

// Anthropic only accepts its own `msg_` ids, and Claude Code echoes the last one back as
// diagnostics.previous_message_id — any other shape there is a 400.
export function toClaudeMessageId(id) {
  const bare = String(id || "").replace(/^chatcmpl-/, "");
  return bare.startsWith("msg_") ? bare : `msg_${bare || Date.now()}`;
}

// Collapse an OpenAI content-part array: a lone text part becomes a plain string,
// otherwise the array is returned as-is. Matches existing translator behavior.
export function collapseTextParts(parts) {
  return parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT ? parts[0].text : parts;
}
