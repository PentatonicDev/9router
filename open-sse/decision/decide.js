// Turns jev's typed answers into a decision. Pure: no fetch, no clock, no state
// of its own — the caller supplies the answers and the previous verdict, which is
// what makes the rules below testable without a network.
//
// Every path that is not a confident, agreeing answer returns a passthrough. A
// decision provider that guesses is worse than one that abstains: abstaining
// costs a few hundred input tokens, guessing costs a wrong model or a wrong tool.

/** A tool name is offered to jev as an option label and, in hint mode, written
 *  into text the model reads. One inert token, no way out of either container. */
const SAFE_NAME = /^[\p{L}\p{N}_.:/-]{1,128}$/u;

/** Roster ceiling. jev accepts 255 options per choice and the state has its own
 *  budget, so a roster this size is not judged — measured: 281 tools is a hard
 *  400 from the API. */
export const MAX_TOOLS = 120;

/** jev answers "no tool needed" as an option in the same choice question. */
export const NO_TOOL = "no_tool_needed";

export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const DEFAULT_SWITCH_CONFIDENCE = 0.85;

/**
 * Whether to change the model serving this session, from the confidence bands.
 *
 * The band split exists because a single threshold cannot separate two situations
 * that were both measured: clear verdicts arrive at 0.96–1.00 (a session that
 * hardened went haiku → sonnet → opus across three turns, all correct), while
 * vague tasks and bad criteria land at 0.43–0.57. Between 0.7 and 0.85 the
 * verdict is real but not certain, and a second agreeing verdict is what makes it
 * worth paying a cache rewrite for.
 */
export function decideSwitch({
  confidence,
  verdict,
  previousVerdict = null,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  switchConfidence = DEFAULT_SWITCH_CONFIDENCE,
} = {}) {
  if (!verdict) return { change: false, reason: "no_verdict" };
  if (!(confidence >= minConfidence)) return { change: false, reason: "low_confidence" };
  if (confidence >= switchConfidence) return { change: true, reason: "clear" };
  if (verdict === previousVerdict) return { change: true, reason: "confirmed" };
  return { change: false, reason: "awaiting_confirmation" };
}

/**
 * Auto-combo: pick the model for this turn.
 *
 * `cheapest` and `dearest` are the pool's price extremes as model strings. Only
 * ONE contradiction is worth blocking: jev says the step needs real deliberation
 * and picks the cheapest model in the pool. That pairing loses quality silently,
 * which is the failure the operator cannot see. The mirror case (a mechanical
 * step on the dearest model) is a cost miss, not a quality one, and confidence
 * already covers it.
 */
export function resolveModelDecision({
  answers,
  models = [],
  cheapest = null,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  switchConfidence = DEFAULT_SWITCH_CONFIDENCE,
  previousVerdict = null,
} = {}) {
  const pick = answers?.model;
  const deliberation = answers?.needs_reasoning;
  if (!pick || pick.type !== "choice" || !models.includes(pick.choice)) {
    return { apply: false, reason: "no_usable_pick" };
  }
  if (!deliberation || deliberation.type !== "noul") {
    return { apply: false, reason: "no_deliberation_signal" };
  }

  // A usable pick is reported even when it is not applied: the caller tracks the
  // previous verdict so two identical answers can unlock the ambiguous band.
  const usable = { model: pick.choice, confidence: pick.confidence, deliberation: deliberation.noul };

  const gate = decideSwitch({
    confidence: pick.confidence,
    verdict: pick.choice,
    previousVerdict,
    minConfidence,
    switchConfidence,
  });
  if (!gate.change) return { apply: false, reason: gate.reason, ...usable };

  // Two independent answers disagreeing is the signal to abstain. Only ONE
  // contradiction is worth blocking: jev says the step needs real deliberation and
  // picks the cheapest model in the pool. That pairing loses quality silently.
  // The mirror case (a mechanical step on the dearest model) is a cost miss, not a
  // quality one, and confidence already covers it.
  const hard = deliberation.noul >= 0.7;
  if (hard && cheapest && pick.choice === cheapest) {
    return { apply: false, reason: "signals_disagree", ...usable };
  }

  return {
    apply: true,
    model: pick.choice,
    confidence: pick.confidence,
    deliberation: deliberation.noul,
    reason: gate.reason,
  };
}

/**
 * Tool routing. Returns the mode to apply and, when there is one, the tool.
 *
 * `cacheSafe` means the request carries no cache breakpoint, so mutating
 * `tool_choice` costs nothing. When a breakpoint IS present the only safe move is
 * a tail hint: changing `tool_choice` rewrites the cached prefix, and on a 60k
 * prefix at the top tier that rewrite costs more than many turns of the saving.
 */
export function resolveToolDecision({
  answers,
  tools = [],
  plans = [],
  cacheSafe = true,
  /** How far the operator lets a decision go, narrowest first. "off" never
   *  touches the request at all, which lets model routing run on its own;
   *  "hint" appends a suggestion and never rewrites tool_choice; "none" adds the
   *  ability to say "call nothing"; "forced" adds pinning a tool. Each is a
   *  strict superset of the one before, so each setting means something. */
  allowed = "forced",
  minConfidence = DEFAULT_MIN_CONFIDENCE,
} = {}) {
  const rank = { off: -1, hint: 0, none: 1, forced: 2 };
  // An unrecognised value falls to the NARROWEST, not the widest: a typo in a
  // setting must never hand the decision more authority than the operator granted.
  const ceiling = rank[allowed] ?? rank.off;
  const allows = (mode) => rank[mode] <= ceiling;

  if (tools.length === 0) return { mode: "passthrough", reason: "no_tools" };
  if (tools.length > MAX_TOOLS) return { mode: "passthrough", reason: "roster_too_large" };
  if (tools.some((name) => typeof name !== "string" || !SAFE_NAME.test(name))) {
    return { mode: "passthrough", reason: "unsafe_tool_name" };
  }
  if (new Set(tools).size !== tools.length) {
    return { mode: "passthrough", reason: "duplicate_tool_names" };
  }
  if (tools.includes(NO_TOOL)) return { mode: "passthrough", reason: "reserved_tool_name" };

  const pick = answers?.tool;
  const needs = answers?.needs_tool;
  if (!pick || pick.type !== "choice" || !needs || needs.type !== "noul") {
    return { mode: "passthrough", reason: "no_usable_answer" };
  }
  if (!tools.includes(pick.choice) && pick.choice !== NO_TOOL) {
    return { mode: "passthrough", reason: "unknown_tool" };
  }
  if (!(pick.confidence >= minConfidence)) {
    return { mode: "passthrough", reason: "low_confidence", confidence: pick.confidence };
  }

  // Two questions must agree before either overrides the model. Measured on a
  // 77-tool roster: the pick landed at 0.40 confidence, and this is the second
  // gate that keeps a marginal verdict from being applied.
  const wantsTool = pick.choice !== NO_TOOL;
  if (wantsTool ? needs.noul < 0.3 : needs.noul > 0.7) {
    return { mode: "passthrough", reason: "signals_disagree", confidence: pick.confidence };
  }

  if (!wantsTool) {
    // Suggesting silence in text would only risk ending an agent's turn early, so
    // "no tool" is only ever applied by pinning it — which needs both a cache-free
    // request and an operator who allows it.
    if (cacheSafe && allows("none")) return { mode: "none", confidence: pick.confidence };
    if (!allows("none")) return { mode: "passthrough", reason: "mode_not_allowed", confidence: pick.confidence };
    return { mode: "passthrough", reason: "cache_breakpoint", confidence: pick.confidence };
  }

  if (!cacheSafe) {
    return allows("hint")
      ? { mode: "hint", tool: pick.choice, confidence: pick.confidence }
      : { mode: "passthrough", reason: "mode_not_allowed", confidence: pick.confidence };
  }

  if (!allows("forced")) {
    // Downgrade rather than abstain: a hint still helps and costs nothing to the cache.
    return allows("hint")
      ? { mode: "hint", tool: pick.choice, confidence: pick.confidence }
      : { mode: "passthrough", reason: "mode_not_allowed", confidence: pick.confidence };
  }

  // Force only tools the target can actually be forced into. A provider-run or
  // namespaced tool is not addressable through tool_choice.
  const plan = plans.find((p) => p.name === pick.choice);
  if (plan && plan.kind && plan.kind !== "function") {
    return { mode: "passthrough", reason: "hosted_tool_selected", confidence: pick.confidence };
  }
  return { mode: "forced", tool: pick.choice, confidence: pick.confidence };
}
