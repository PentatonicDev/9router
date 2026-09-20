/**
 * Bedrock Converse → OpenAI response translator
 *
 * The executor (open-sse/executors/bedrock.js) re-encodes the SDK's
 * `ConverseStreamOutput` async-iterable as one `data: {json}\n\n` line per event,
 * so each `chunk` here is exactly one Bedrock event object with a single set key
 * (messageStart | contentBlockStart | contentBlockDelta | contentBlockStop |
 * messageStop | metadata | *Exception — confirmed discriminated union, SDK types).
 *
 * Mirrors the commandcode-to-openai.js state-machine shape: state.finishReason is
 * set on messageStop (no chunk yet, mirroring commandcode's "finish-step"), and
 * the final chunk + usage is emitted on `metadata` (Bedrock's guaranteed last
 * event on success — mirrors commandcode's "finish").
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { reasoningDelta } from "../concerns/reasoning.js";

function ensureState(state, model) {
  if (!state.responseId) {
    state.responseId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.model = state.model || model || "bedrock";
    state.chunkIndex = 0;
    state.toolIndex = 0;
    state.toolIndexByBlock = new Map();
    state.finishReason = null;
    state.usage = null;
  }
}

function makeChunk(state, delta, finishReason = null) {
  return buildChunk({ id: state.responseId, created: state.created, model: state.model }, delta, finishReason);
}

export function bedrockConverseToOpenAIResponse(chunk, state) {
  if (!chunk || typeof chunk !== "object") return null;
  ensureState(state, state?.model);

  if (chunk.messageStart) {
    state.chunkIndex++;
    return makeChunk(state, { role: ROLE.ASSISTANT, content: "" });
  }

  if (chunk.contentBlockStart) {
    const { start, contentBlockIndex } = chunk.contentBlockStart;
    const toolUse = start?.toolUse;
    if (!toolUse) return null;
    const idx = state.toolIndex++;
    state.toolIndexByBlock.set(contentBlockIndex, idx);
    state.chunkIndex++;
    return makeChunk(state, {
      tool_calls: [{
        index: idx,
        id: toolUse.toolUseId || fallbackToolCallId(idx),
        type: OPENAI_BLOCK.FUNCTION,
        function: { name: toolUse.name || "", arguments: "" },
      }],
    });
  }

  if (chunk.contentBlockDelta) {
    const { delta, contentBlockIndex } = chunk.contentBlockDelta;
    if (!delta) return null;
    if (typeof delta.text === "string" && delta.text) {
      state.chunkIndex++;
      return makeChunk(state, { content: delta.text });
    }
    if (delta.toolUse && typeof delta.toolUse.input === "string") {
      const idx = state.toolIndexByBlock.get(contentBlockIndex);
      if (idx == null) return null;
      state.chunkIndex++;
      return makeChunk(state, { tool_calls: [{ index: idx, function: { arguments: delta.toolUse.input } }] });
    }
    if (delta.reasoningContent) {
      // Claude-on-Bedrock's thinking passthrough: { text } | { redactedContent } |
      // { signature }. Only text has an OpenAI equivalent (reasoning_content);
      // redactedContent/signature carry no client-visible text and are consumed
      // silently rather than emitted as an empty/garbled delta.
      const text = delta.reasoningContent.text;
      if (typeof text === "string" && text) {
        state.chunkIndex++;
        return makeChunk(state, reasoningDelta(text));
      }
      return null;
    }
    return null;
  }

  if (chunk.contentBlockStop) {
    return null; // bookkeeping only, matches commandcode's tool-input-end/text-end no-op
  }

  if (chunk.messageStop) {
    state.finishReason = toOpenAIFinish(chunk.messageStop.stopReason, "bedrock");
    return null;
  }

  if (chunk.metadata) {
    const finishReason = state.finishReason || toOpenAIFinish(null, "bedrock");
    const finalChunk = makeChunk(state, {}, finishReason);
    const usage = toOpenAIUsage(chunk.metadata.usage, "bedrock");
    if (usage) {
      finalChunk.usage = usage;
      state.usage = usage; // read by utils/stream.js finalizeStream() for request logging
    }
    return finalChunk;
  }

  // internalServerException | modelStreamErrorException | validationException |
  // throttlingException | serviceUnavailableException never reach here: the
  // executor (open-sse/executors/bedrock.js) re-encodes them as a `chunk.error`
  // frame before they enter this translator, so the generic stream pipeline's
  // extractStreamError() (open-sse/utils/streamHelpers.js), which only checks
  // the raw pre-translation chunk, already turns them into a client-format
  // error frame upstream of this function — falls through to the catch-all
  // `null` below rather than throwing, defensively, should that invariant
  // ever break (throwing here would abort the stream with no error content
  // delivered to the client, exactly the bug this split exists to avoid).
  return null;
}

register(FORMATS.BEDROCK_CONVERSE, FORMATS.OPENAI, null, bedrockConverseToOpenAIResponse);
