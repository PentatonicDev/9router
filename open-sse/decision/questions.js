// Builds the typed questions jev answers.
//
// Every builder returns `{ questions }` — one shape, no exception. A split shape
// once let a caller destructure undefined and fail open silently.
//
// Questions are cheap: they are evaluated in parallel, so one call can ask both
// "which one" and "does this even need one".

import { NO_TOOL, MAX_TOOLS } from "./decide.js";

const MAX_DESCRIPTION_CHARS = 1024;
/** Description budget per tool question (~12k tokens). */
const QUESTION_CHAR_BUDGET = 48000;
/** Kept per shard by the first pass. */
export const SHORTLIST_PER_SHARD = 3;
/** A shard's abstention option. */
export const NONE_OF_THESE = "none_of_these";

export const MODEL_KEY = "model";
export const DELIBERATION_KEY = "needs_reasoning";
export const TOOL_KEY = "tool";
export const NEEDS_TOOL_KEY = "needs_tool";

/** Descriptions lead with what the tool is for; the tail is usage detail. */
function toolCriteria(tools) {
  const limit = Math.max(80, Math.min(MAX_DESCRIPTION_CHARS, Math.floor(QUESTION_CHAR_BUDGET / tools.length)));
  const criteria = {};
  for (const tool of tools) {
    const description = typeof tool.description === "string" ? tool.description.trim() : "";
    criteria[tool.name] = description.slice(0, limit) || `The ${tool.name} tool.`;
  }
  return criteria;
}

/**
 * Which tool to call next, and whether any is needed. The two are independent on
 * purpose: the caller applies an answer only when both agree.
 */
export function buildToolQuestions(tools) {
  const criteria = toolCriteria(tools);
  criteria[NO_TOOL] =
    "No tool call is needed right now: reply to the user in plain text (answer " +
    "directly, ask a clarifying question, or report what tools already returned).";
  return {
    questions: {
      [TOOL_KEY]: {
        type: "choice",
        instructions:
          "Given the conversation, what should the assistant do next? Pick the single " +
          "tool whose call best advances the user's latest request.",
        criteria,
      },
      [NEEDS_TOOL_KEY]: {
        type: "noul",
        instructions:
          "Does the assistant need to call one of its tools now, rather than reply to " +
          "the user in plain text?",
      },
    },
  };
}

/** First pass over a roster too large for one question: rank wide, then judge a shortlist. */
export function buildShortlistQuestions(tools) {
  const shardCount = Math.ceil(tools.length / MAX_TOOLS);
  const size = Math.ceil(tools.length / shardCount);
  const shards = Array.from({ length: shardCount }, (_, i) => tools.slice(i * size, (i + 1) * size));
  const questions = {};
  shards.forEach((shard, index) => {
    questions[`shard:${index}`] = {
      type: "choice",
      instructions:
        "Given the conversation, which of these tools would best advance the user's " +
        "latest request if the assistant called it next?",
      criteria: {
        ...toolCriteria(shard),
        [NONE_OF_THESE]: "None of the tools in this list fits the next step.",
      },
    };
  });
  return { questions, shards };
}

/** The tools that survived the first pass. */
export function readShortlist(answers, shards) {
  return shards.flatMap((shard, index) => {
    const answer = answers?.[`shard:${index}`];
    if (!answer || answer.type !== "choice") return [];
    const ranked = Object.entries(answer.probabilities || {})
      .filter(([name]) => name !== NONE_OF_THESE)
      .sort(([, a], [, b]) => b - a)
      .slice(0, SHORTLIST_PER_SHARD)
      .map(([name]) => name);
    return shard.filter((tool) => ranked.includes(tool.name));
  });
}

/**
 * The reasoning depth the next step needs, as ordered levels. The tier each level
 * maps to is decided in code, not by the model: a rate table is arithmetic, and
 * arithmetic is a documented jaggedness weakness of the decision model. Asking a
 * Choice over models with prices in the criteria measured 0.62 against the same
 * state that scores 0.82 here — the model judged the task fine and the price
 * comparison is what it could not do.
 */
/**
 * Which model should serve this step, and how much deliberation it needs.
 *
 * `criteriaFor` must return what the model is FOR: capability flags alone decided
 * 0/4 correctly against 5/5 for a curated brief (measured). No price is in that
 * text — comparing a rate table is arithmetic, a documented weakness of the
 * decision model, and measured here as the difference between a 0.62 verdict and
 * a 0.82 one. Cost decides only among the models it already judged fit, in code.
 */
export function buildModelQuestions(models, criteriaFor) {
  const criteria = {};
  for (const model of models) {
    const text = criteriaFor(model);
    if (text) criteria[model] = text;
  }
  return {
    questions: {
      [MODEL_KEY]: {
        type: "choice",
        instructions:
          "Which model should handle the next step? Judge only fitness for the task: " +
          "pick the one whose description matches what the step actually needs.",
        criteria,
      },
      [DELIBERATION_KEY]: {
        type: "noul",
        instructions:
          "Does this next step need real deliberation (multi-step reasoning, " +
          "architecture, non-obvious debugging), or is it mechanical?",
      },
    },
  };
}

/** Tools kept for jev when a roster is too big to judge well. */
export const SHORTLIST_MAX = 24;

/**
 * Narrows a large roster deterministically, with no extra decision call. A choice
 * over 280 tools measured 0.40 confidence — below the threshold, so the verdict was
 * discarded after paying for it. Lexical overlap with the latest request plus reuse
 * of what the conversation already called is enough to bring the question back into
 * range, and it cuts the per-turn token cost of the roster at the same time.
 *
 * ponytail: word overlap, not semantics. If the bench shows it dropping the tool
 * that mattered, raise SHORTLIST_MAX or score by embedding.
 */
export function shortlistTools(tools, body, max = SHORTLIST_MAX) {
  if (tools.length <= max) return tools;

  const words = new Set(
    lastUserText(body).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 2)
  );
  const used = toolsUsedIn(body);

  const scored = tools.map((tool, index) => {
    const hay = `${tool.name} ${tool.description || ""}`.toLowerCase();
    let score = 0;
    for (const word of words) if (hay.includes(word)) score += 1;
    if (used.has(tool.name)) score += 3;
    return { tool, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, max).map((entry) => entry.tool);
}

/** The latest user turn, whichever message shape the body uses. */
function lastUserText(body) {
  const turns = body?.messages || body?.input || body?.contents || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === "user") return textOfContent(turns[i].content) || "";
  }
  return "";
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || "").join(" ");
}

/** Names the conversation already called, so a repeated need survives the cut. */
function toolsUsedIn(body) {
  const names = new Set();
  for (const turn of body?.messages || []) {
    for (const call of turn?.tool_calls || []) {
      const name = call?.function?.name || call?.name;
      if (name) names.add(name);
    }
    for (const block of Array.isArray(turn?.content) ? turn.content : []) {
      if (block?.type === "tool_use" && block.name) names.add(block.name);
    }
  }
  return names;
}
