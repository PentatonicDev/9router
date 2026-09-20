// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { createErrorDescriptor } from "./error.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "response.incomplete",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed" || status === "incomplete";
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes(error = null) {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure(error)}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure(error = null) {
  const descriptor = error
    ? createErrorDescriptor(error.statusCode || 502, error.message)
    : null;
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: descriptor ? {
          type: descriptor.error.type,
          code: descriptor.code,
          message: descriptor.error.message,
        } : {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
