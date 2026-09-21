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
 * Which model should serve this step, and how much deliberation it needs.
 * `criteriaFor` must return what the model is FOR: price and capability flags alone
 * decided 0/4 correctly against 5/5 for a curated brief (measured).
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
          "Which model should handle the next step? Pick the cheapest one that still " +
          "handles this task well — weigh the task's real difficulty against the cost.",
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
