// Reads the tool roster out of a body that has already been translated to the
// target format.
//
// Reading the TARGET body, not the client's, is the only correct place: the names
// jev picks are written back into `tool_choice`, and tool_choice addresses the
// names the upstream will see. The client-side names are reconciled through
// `_toolNameMap`, which chatCore deletes before this point.

import { FORMATS } from "../translator/formats.js";

/** Providers whose upstream wire format is binary/NDJSON and never passes through
 *  the translator. There is no `tool_choice` to write there, so tool routing is
 *  unconditionally a passthrough for them. (Auto-combo is unaffected: it only
 *  changes the `model` field.) */
export const UNSUPPORTED_EXECUTORS = new Set([
  "kiro",
  "cursor",
  "commandcode",
  "windsurf",
  "devin-cli",
  "zed",
]);

/**
 * @returns {Array<{name: string, description?: string, kind: "function"|"hosted"}>}
 */
export function extractTools(body, format) {
  if (!body || typeof body !== "object") return [];

  // Gemini / Vertex / Antigravity carry the roster nested under a tool object.
  if (isGemini(format)) {
    const decls = [];
    for (const tool of asArray(body.tools)) {
      for (const fn of asArray(tool?.functionDeclarations)) decls.push(fn);
    }
    return decls
      .filter((fn) => typeof fn?.name === "string")
      .map((fn) => ({ name: fn.name, description: fn.description, kind: "function" }));
  }

  // Bedrock Converse.
  const converseTools = body.toolConfig?.tools;
  if (Array.isArray(converseTools) || format === FORMATS.BEDROCK_CONVERSE) {
    return asArray(converseTools)
      .map((entry) => entry?.toolSpec)
      .filter((spec) => typeof spec?.name === "string")
      .map((spec) => ({ name: spec.name, description: spec.description, kind: "function" }));
  }

  const out = [];
  const hosted = new Set();
  for (const tool of asArray(body.tools)) {
    // Anthropic: a versioned `type` (web_search_20250305) is provider-run and
    // cannot be forced by name; "custom" or absent is a client tool.
    const type = tool?.type;
    if (typeof type === "string" && type !== "function" && type !== "custom") {
      if (hosted.has(type)) continue; // the same built-in listed twice is one option
      hosted.add(type);
      out.push({ name: tool.name || type, description: tool.description, kind: "hosted" });
      continue;
    }
    if (typeof tool?.name === "string") {
      out.push({ name: tool.name, description: tool.description, kind: "function" });
      continue;
    }
    const fn = tool?.function;
    if (typeof fn?.name === "string") {
      out.push({ name: fn.name, description: fn.description, kind: "function" });
      continue;
    }
    const custom = tool?.custom;
    if (typeof custom?.name === "string") {
      out.push({ name: custom.name, description: custom.description, kind: "hosted" });
    }
  }
  return out;
}

export function isGemini(format) {
  return (
    format === FORMATS.GEMINI ||
    format === FORMATS.GEMINI_CLI ||
    format === FORMATS.VERTEX ||
    format === FORMATS.ANTIGRAVITY
  );
}

/** Formats where writing `tool_choice` is a documented, working operation. */
export function supportsToolChoice(format) {
  return (
    format === FORMATS.OPENAI ||
    format === FORMATS.OPENAI_RESPONSES ||
    format === FORMATS.OPENAI_RESPONSE ||
    format === FORMATS.CLAUDE ||
    format === FORMATS.BEDROCK_CONVERSE ||
    format === FORMATS.OLLAMA
  );
}

/** Writes the decision into the target body. Returns true when it changed. */
export function applyToolChoice(body, format, decision) {
  if (!body || typeof body !== "object" || !decision) return false;
  try {
    if (decision.mode === "none") {
      if (format === FORMATS.CLAUDE) body.tool_choice = { type: "none" };
      else if (format === FORMATS.BEDROCK_CONVERSE) {
        body.toolConfig = { ...(body.toolConfig || {}), toolChoice: { none: {} } };
      } else body.tool_choice = "none";
      return true;
    }
    if (decision.mode === "forced") {
      if (format === FORMATS.CLAUDE) body.tool_choice = { type: "tool", name: decision.tool };
      else if (format === FORMATS.BEDROCK_CONVERSE) {
        body.toolConfig = { ...(body.toolConfig || {}), toolChoice: { tool: { name: decision.tool } } };
      } else body.tool_choice = { type: "function", function: { name: decision.tool } };
      return true;
    }
  } catch {
    // A decision is an optimisation; never let it break the request.
  }
  return false;
}

const asArray = (value) => (Array.isArray(value) ? value : []);
