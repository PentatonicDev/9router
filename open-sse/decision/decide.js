// Turns jev's typed answers into a decision. Pure, so the rules are testable
// without a network. Anything short of a confident, agreeing answer abstains.

/** A tool name becomes an option label and, in hint mode, model-readable text. */
const SAFE_NAME = /^[\p{L}\p{N}_.:/-]{1,128}$/u;

/** jev caps a choice at 255 options — measured: 281 tools is a hard 400. */
export const MAX_TOOLS = 120;

/** jev answers "no tool needed" as an option in the same choice question. */
export const NO_TOOL = "no_tool_needed";

export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const DEFAULT_SWITCH_CONFIDENCE = 0.85;

/**
 * Whether to change the model serving this session. One threshold cannot separate
 * what was measured: clear verdicts land at 0.96–1.00, vague tasks and bad criteria
 * at 0.43–0.57. In between, a second agreeing verdict is what justifies the cache
 * rewrite a switch costs.
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
 * Auto-combo: pick the model for this turn. `cheapest` is the pool's cheapest entry.
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

  // Reported even when not applied: the caller tracks the previous verdict.
  const usable = { model: pick.choice, confidence: pick.confidence, deliberation: deliberation.noul };

  const gate = decideSwitch({
    confidence: pick.confidence,
    verdict: pick.choice,
    previousVerdict,
    minConfidence,
    switchConfidence,
  });
  if (!gate.change) return { apply: false, reason: gate.reason, ...usable };

  // The one contradiction worth blocking: a step that needs deliberation routed to
  // the cheapest model loses quality silently. Mechanical work on an expensive model
  // is only a cost miss, which confidence already covers.
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
 * Tool routing: the mode to apply, and the tool when there is one. `tool_choice` is
 * a top-level parameter, so changing it does not touch the cached prefix — measured,
 * same 3,584 tokens read from cache with and without the change.
 */
export function resolveToolDecision({
  answers,
  tools = [],
  plans = [],
  /** How far a verdict may go, narrowest first: off < hint < none < forced.
   *  Each is a strict superset of the previous. */
  allowed = "forced",
  minConfidence = DEFAULT_MIN_CONFIDENCE,
} = {}) {
  const rank = { off: -1, hint: 0, none: 1, forced: 2 };
  // Unrecognised falls to the narrowest: a typo must not grant more authority.
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
    // "no tool" is applied by pinning it.
    if (allows("none")) return { mode: "none", confidence: pick.confidence };
    return { mode: "passthrough", reason: "mode_not_allowed", confidence: pick.confidence };
  }

  if (!allows("forced")) {
    // Downgrade rather than abstain: a hint still helps.
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
