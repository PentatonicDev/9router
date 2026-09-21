// Builds the typed questions jev answers. Questions are cheap — extra ones barely
// change latency because they are evaluated in parallel — so one call can ask
// both "which one" and "does this even need one".
//
// Measured constraint that shapes all of this: a `choice` question accepts at
// most 255 options, and Claude Code sends ~280 tools. A single question over a
// full roster is not slow, it is a 400.

import { NO_TOOL, MAX_TOOLS } from "./decide.js";

const MAX_DESCRIPTION_CHARS = 1024;
/** Characters one tool question may spend on descriptions (~12k tokens). */
const QUESTION_CHAR_BUDGET = 48000;
/** Kept per shard by the first pass, when a roster is too big for one question. */
export const SHORTLIST_PER_SHARD = 3;
/** "None of these fits" option a shard uses to abstain. */
export const NONE_OF_THESE = "none_of_these";

export const MODEL_KEY = "model";
export const DELIBERATION_KEY = "needs_reasoning";
export const TOOL_KEY = "tool";
export const NEEDS_TOOL_KEY = "needs_tool";

/** Tool descriptions lead with what the tool is for; the tail is usage detail. */
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
 * Which tool to call next, and whether any is needed.
 *
 * The two questions are independent on purpose: the caller only applies an answer
 * when both agree, which is what keeps a marginal verdict from overriding the
 * model.
 *
 * No option here may be anything but a real tool name. A non-tool option in a
 * model-choice question was measured to absorb 39-45% of the probability mass and
 * destroy the decision — the same trap a "none of these" option would set here.
 */
export function buildToolQuestions(tools) {
  const criteria = toolCriteria(tools);
  criteria[NO_TOOL] =
    "No tool call is needed right now: reply to the user in plain text (answer " +
    "directly, ask a clarifying question, or report what tools already returned).";
  return {
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
  };
}

/**
 * First pass over a roster too large for one question: every shard is ranked in
 * the same call, and the best few of each go on to the real decision. Ranking
 * wide, then judging a shortlist.
 */
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

/** The tools of each shard that survived the first pass. */
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
 *
 * `criteriaFor(model)` must return the "what this model is FOR" text — price and
 * capability flags alone were measured to decide 0/4 correctly vs 5/5 for a
 * curated brief. The second question exists so the caller can refuse to apply a
 * pick that contradicts it.
 */
export function buildModelQuestions(models, criteriaFor) {
  const criteria = {};
  for (const model of models) {
    const text = criteriaFor(model);
    if (text) criteria[model] = text;
  }
  return {
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
  };
}
