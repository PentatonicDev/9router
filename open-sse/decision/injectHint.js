// Appends a routing hint to the very end of the conversation.
//
// Deliberately NOT open-sse/rtk/systemInject.js. That injector places its block
// *before* the last cache_control breakpoint (injectClaudeSystem splices at
// lastCacheIdx) — correct for caveman/ponytail, whose prompt is the same stable
// string on every request and therefore belongs inside the cached prefix. A hint
// is volatile: it names the tool this turn, so inside the prefix it would rewrite
// the cache on every single request. Appending after the breakpoints leaves the
// cached prefix byte-identical, which is the whole point.
//
// Fail-open and idempotent, like every other body mutator in this codebase.

import { FORMATS } from "../translator/formats.js";

const SEP = "\n\n";

/** One inert token, no whitespace or quoting to break out of the reminder. */
const SAFE_NAME = /^[\p{L}\p{N}_.:/-]{1,128}$/u;

export function hintText(tool) {
  if (typeof tool !== "string" || !SAFE_NAME.test(tool)) return null;
  return (
    `<system-reminder>A tool-routing model suggests the "${tool}" tool is the most ` +
    `relevant next step. Ignore this if it does not fit what the user actually asked for.` +
    `</system-reminder>`
  );
}

/** @returns {boolean} whether the body changed */
export function injectHint(body, format, tool) {
  const text = hintText(tool);
  if (!text || !body || typeof body !== "object") return false;
  try {
    if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
      return pushGemini(body, text);
    }
    if (Array.isArray(body.contents)) return pushGemini(body, text);
    if (Array.isArray(body.input)) return pushResponses(body.input, text);
    if (Array.isArray(body.messages)) return pushMessages(body.messages, text);
  } catch {
    // A hint is an optimisation; never let it break the request.
  }
  return false;
}

const lastUser = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user") return messages[i];
  }
  return null;
};

function alreadyHas(content, text) {
  if (typeof content === "string") return content.includes(text);
  if (Array.isArray(content)) return content.some((b) => b && typeof b.text === "string" && b.text.includes(text));
  return false;
}

/** OpenAI chat and Claude Messages share the {role, content} shape. */
function pushMessages(messages, text) {
  const target = lastUser(messages);
  if (!target || alreadyHas(target.content, text)) return false;
  if (typeof target.content === "string") {
    if (!target.content) return false;
    target.content = [{ type: "text", text: target.content }, { type: "text", text }];
  } else if (Array.isArray(target.content)) {
    target.content.push({ type: "text", text });
  } else {
    return false;
  }
  // Bedrock Converse carries a cachePoint as the last content block; the hint has
  // to land after it, which pushing already guarantees.
  return true;
}

/** OpenAI Responses: input[] of items, the last user message typed. */
function pushResponses(input, text) {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item || item.role !== "user") continue;
    if (alreadyHas(item.content, text)) return false;
    if (typeof item.content === "string") {
      if (!item.content) return false;
      item.content = [{ type: "input_text", text: item.content }, { type: "input_text", text }];
      return true;
    }
    if (Array.isArray(item.content)) {
      item.content.push({ type: "input_text", text });
      return true;
    }
    return false;
  }
  return false;
}

/** Gemini / Vertex / Antigravity: contents[] with parts[]. */
function pushGemini(body, text) {
  const contents = Array.isArray(body.contents) ? body.contents : null;
  if (!contents || contents.length === 0) return false;
  const last = contents[contents.length - 1];
  const parts = Array.isArray(last?.parts) ? last.parts : null;
  if (!parts) return false;
  if (parts.some((p) => p && typeof p.text === "string" && p.text.includes(text))) return false;
  parts.push({ text });
  return true;
}

export { SEP };
