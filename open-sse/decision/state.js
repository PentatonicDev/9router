// Builds the `state` jev is asked about, walking any message-shaped array the client
// sent rather than one adapter per source format.
//
// ponytail: generic and lossy, unrecognised shapes degrade to truncated JSON.
// Upgrade path: per-format extractors if the bench shows fidelity costs decisions.

const TRUNCATION_MARK = " …[truncated]… ";

/** Head and tail; the middle of a long blob matters least. */
export function truncate(text, max) {
  if (typeof text !== "string" || text.length <= max) return text || "";
  const keep = Math.max(0, max - TRUNCATION_MARK.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + TRUNCATION_MARK + text.slice(text.length - (keep - head));
}

/** jev is text-only: flatten parts, placeholder for anything else. */
export function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        if (part && typeof part.content === "object") return textOf(part.content);
        return `[${part?.type || "attachment"}]`;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return String(content);
}

/** The message-shaped array, whichever known shape the client used. */
function turnsOf(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) {
    // OpenAI Responses: `instructions` carries the system text, input[] the turns.
    return body.input;
  }
  if (Array.isArray(body?.contents)) return body.contents;      // Gemini
  if (Array.isArray(body?.conversation?.messages)) return body.conversation.messages;
  return null;
}

function systemTextOf(body) {
  const parts = [];
  if (typeof body?.system === "string") parts.push(body.system);
  else if (Array.isArray(body?.system)) parts.push(textOf(body.system));
  else if (body?.system) parts.push(textOf(body.system));
  if (typeof body?.instructions === "string") parts.push(body.instructions);
  if (typeof body?.system_instruction === "string") parts.push(body.system_instruction);
  const sysConfig = body?.systemInstruction?.parts || body?.system_instruction?.parts;
  if (Array.isArray(sysConfig)) parts.push(textOf(sysConfig));
  return parts.filter(Boolean).join("\n\n");
}

/** @param {object} body the client's body, before translation */
export function buildState(body, { maxStateChars = 24000, maxMessageChars = 4000 } = {}) {
  const systemText = truncate(systemTextOf(body), maxMessageChars);
  const turns = turnsOf(body);

  if (!turns) {
    // Unknown shape: a truncated picture rather than nothing.
    return { request: truncate(safeStringify(body), maxStateChars) };
  }

  const conversation = [];
  let budget = maxStateChars - systemText.length;
  // Newest first: the current task is what survives a spent budget.
  for (let i = turns.length - 1; i >= 0; i--) {
    const msg = turns[i];
    if (!msg || typeof msg !== "object") continue;
    const entry = {
      role: typeof msg.role === "string" ? msg.role : "user",
      text: truncate(textOf(msg.content) || textOf(msg.parts), maxMessageChars),
    };
    const tools = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
    if (tools?.length) {
      entry.tool_calls = tools.slice(0, 8).map((call) => ({
        tool: call?.function?.name || call?.name || "unknown",
      }));
    }
    if (msg.role === "tool" || msg.role === "function") {
      entry.role = "tool_result";
      entry.text = truncate(entry.text, 600);
    }
    budget -= JSON.stringify(entry).length;
    if (budget < 0 && conversation.length > 0) break;
    conversation.unshift(entry);
  }

  const omitted = turns.length - conversation.length;
  return {
    ...(systemText ? { assistant_instructions: systemText } : {}),
    ...(omitted > 0 ? { earlier_turns_omitted: omitted } : {}),
    conversation,
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** True when the body carries an explicit cache breakpoint — the signal
 *  that mutating anything before the tail would cost a cache rewrite. */
export function hasCacheBreakpoint(body) {
  if (body?.cache_control) return true;
  const sys = body?.system;
  if (Array.isArray(sys) && sys.some((b) => b?.cache_control)) return true;
  const tools = body?.tools;
  if (Array.isArray(tools) && tools.some((t) => t?.cache_control)) return true;
  const msgs = turnsOf(body);
  if (msgs) {
    for (const msg of msgs) {
      if (msg?.cache_control) return true;
      if (Array.isArray(msg?.content) && msg.content.some((b) => b?.cache_control)) return true;
    }
  }
  return false;
}
