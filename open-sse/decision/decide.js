// Turns jev's typed answers into a decision. Pure, so the rules are testable
// without a network. Anything short of a confident, agreeing answer abstains.

/** A tool name becomes an option label and, in hint mode, model-readable text. */
const SAFE_NAME = /^[\p{L}\p{N}_.:/-]{1,128}$/u;

/** jev caps a choice at 255 options — measured: 281 tools is a hard 400. */
export const MAX_TOOLS = 120;

/** jev answers "no tool needed" as an option in the same choice question. */
export const NO_TOOL = "no_tool_needed";

/** The tool gate, still in confidence units: jev's answer for a tool roster is a
 *  Choice too, so its confidence scales with the roster size as well. Splitting the
 *  two gates is deliberate — moving the model gate to a normalized score does not
 *  make the tool roster's own scaling measured, and this number stays where it was
 *  until it is. */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

/** The model gate, in WINNER-STRENGTH units: how far the winner's probability sits
 *  above the uniform baseline (1/options), rescaled to 0..1. Absolute confidence
 *  cannot gate here — jev scales it by the option count, measured on one state as
 *  1.00 over 3 options, 0.45 over 6 and 0.31 over 12 — so a threshold on it tightened
 *  silently every time the pool grew, discarding 97% of verdicts.
 *
 *  Measured on 383 production verdicts over the 12-model pool: at 0.35 it admits 100%
 *  of the calls whose winner held half the mass, rejects 100% of the coin flips, and
 *  covers 40% of traffic. At 0.30 the coverage is 53% but a quarter of the coin flips
 *  get through. */
export const DEFAULT_MIN_STRENGTH = 0.35;
export const DEFAULT_SWITCH_STRENGTH = 0.6;

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
 * The pool ordered cheapest first. Ties keep the pool's own order, so a caller that
 * already ranked its models keeps that rank. A model with no known price sorts last:
 * it cannot be shown to be the cheap choice.
 */
export function rankByCost(models, priceOf) {
  return models
    .map((model, index) => ({ model, index, price: priceOf(model) }))
    .sort((a, b) => {
      if (a.price === null && b.price === null) return a.index - b.index;
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return a.price - b.price || a.index - b.index;
    })
    .map((entry) => entry.model);
}

/** How far the runner-up must trail the winner for the verdict to be a decision
 *  rather than a coin flip. Absolute confidence cannot serve here: jev scales it by
 *  the option count — measured on one state, the same winner scored 1.00 over 3
 *  options, 0.45 over 6 and 0.31 over 12 — so a threshold on it silently tightened
 *  when the pool expanded. The separation between the top two does not move that way. */
export const TIE_BAND = 0.15;

/** The pool's cheapest entry, or nothing when there is no price to rank by. */
const cheapestOf = (models, priceOf) => (priceOf ? rankByCost(models, priceOf)[0] : null);

/**
 * The cheapest model jev rated as good as its pick.
 *
 * jev answers which model FITS — it is never asked which is cheaper, because
 * comparing a rate table is arithmetic and the prices are ours to read exactly.
 * So the saving is taken here: among the options within `band` of the winning
 * probability — the ones it did not meaningfully separate — the cheapest wins.
 * A clear verdict has no one else in the band and is left untouched.
 */
export function cheapestWithinBand(pick, probabilities, priceOf, band = TIE_BAND) {
  const top = probabilities?.[pick];
  if (typeof top !== "number") return pick;
  let best = pick;
  let bestPrice = priceOf(pick);
  if (bestPrice === null) return pick;
  for (const [model, p] of Object.entries(probabilities)) {
    if (typeof p !== "number" || top - p > band) continue;
    const price = priceOf(model);
    // An unpriced model never wins a tie-break: unknown is not cheap.
    if (price === null || price >= bestPrice) continue;
    best = model;
    bestPrice = price;
  }
  return best;
}

/**
 * Auto-combo: the model for this turn.
 *
 * jev picks the model; cost only breaks the ties it left behind. See
 * `cheapestWithinBand` for why the price never enters the question itself.
 *
 * The gate is the winner's STRENGTH against the uniform baseline, not the confidence
 * jev reports: that value tracks how many options the question offered, so the same
 * winner reads 1.00 in a pool of 3 and 0.31 in a pool of 12. Gating on it discarded
 * 97% of verdicts once the pool was expanded, including ones where the winner held
 * most of the mass. See `winnerStrength` and `decideStrength`.
 */
export function resolveModelDecision({
  answers,
  models = [],
  priceOf = null,
  minStrength = DEFAULT_MIN_STRENGTH,
  switchStrength = DEFAULT_SWITCH_STRENGTH,
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

  // Among the models jev did not meaningfully separate, take the cheapest. This
  // only moves sideways inside its own verdict — never past a model it rated lower.
  const chosen = priceOf
    ? cheapestWithinBand(pick.choice, pick.probabilities, priceOf)
    : pick.choice;
  const strength = winnerStrength(pick);

  // Reported even when not applied: the caller tracks the previous verdict.
  const usable = {
    model: chosen,
    confidence: pick.confidence,
    strength,
    deliberation: deliberation.noul,
    ...(chosen !== pick.choice ? { downgradedFrom: pick.choice } : {}),
  };

  const gate = decideStrength({
    strength,
    verdict: chosen,
    previousVerdict,
    minStrength,
    switchStrength,
  });
  if (!gate.change) return { apply: false, reason: gate.reason, ...usable };

  // The one contradiction worth blocking: a step that needs deliberation routed to
  // the cheapest model loses quality silently. Mechanical work on an expensive model
  // is only a cost miss, which confidence already covers.
  const cheapest = cheapestOf(models, priceOf);
  const hard = deliberation.noul >= 0.7;
  if (hard && cheapest && chosen === cheapest) {
    return { apply: false, reason: "signals_disagree", ...usable };
  }

  return { apply: true, ...usable, reason: gate.reason };
}

/**
 * How strong the winner is: its probability measured against the uniform baseline
 * of the option count, rescaled so 0 is "no favourite at all" and 1 is "everything
 * on one option".
 *
 * `(p1 - 1/n) / (1 - 1/n)`. The subtraction is what removes the option count: the
 * same share of the mass scores the same in a pool of 3 and a pool of 12, which the
 * raw probability does not. It is a monotone transform of a likelihood ratio against
 * the uniform prior, the form selective classification theory gives as optimal.
 */
export function winnerStrength(pick) {
  const probs = Object.values(pick?.probabilities || {}).filter((v) => typeof v === "number");
  const n = probs.length;
  if (n === 0) return 0;
  if (n === 1) return probs[0] > 0 ? 1 : 0;
  const p1 = Math.max(...probs);
  const floor = 1 / n;
  return Math.max(0, Math.min(1, (p1 - floor) / (1 - floor)));
}

/**
 * Whether the separation justifies changing the model serving this session.
 *
 * The bands come from the same measurement the confidence gate used: a clear
 * verdict separates widely (measured median 0.48), a vague task or a bad pool does
 * not (measured median 0.02). In between, a second agreeing verdict is what
 * justifies the cache rewrite a switch costs.
 */
export function decideStrength({
  strength,
  verdict,
  previousVerdict = null,
  minStrength = DEFAULT_MIN_STRENGTH,
  switchStrength = DEFAULT_SWITCH_STRENGTH,
} = {}) {
  if (!verdict) return { change: false, reason: "no_verdict" };
  if (!(strength >= minStrength)) return { change: false, reason: "no_favourite" };
  if (strength >= switchStrength) return { change: true, reason: "clear" };
  if (verdict === previousVerdict) return { change: true, reason: "confirmed" };
  return { change: false, reason: "awaiting_confirmation" };
}

/**
 * Tool routing: the mode to apply, and the tool when there is one. `tool_choice` is
 * a top-level parameter, so changing it does not touch the cached prefix — measured,
 * same 3,584 tokens read from cache with and without the change.
 *
 * `extendedThinking` caps the mode at `hint`. Anthropic rejects a pinned
 * tool_choice while thinking is enabled ("Thinking mode does not support this
 * tool_choice"), and the same restriction applies to the extended-thinking beta on
 * compatible endpoints.
 */
export function resolveToolDecision({
  answers,
  tools = [],
  plans = [],
  /** How far a verdict may go, narrowest first: off < hint < none < forced.
   *  Each is a strict superset of the previous. */
  allowed = "forced",
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  extendedThinking = false,
} = {}) {
  const rank = { off: -1, hint: 0, none: 1, forced: 2 };
  // A pin cannot survive extended thinking, so the ceiling drops to `hint` — the
  // one mode that still reaches the model without writing tool_choice.
  const requested = rank[allowed] ?? rank.off;
  const ceiling = extendedThinking ? Math.min(requested, rank.hint) : requested;
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
    // Downgrade rather than abstain: a hint still helps. Recorded separately so the
    // thinking downgrade is distinguishable from a config ceiling in the detail row.
    if (allows("hint")) {
      return {
        mode: "hint",
        tool: pick.choice,
        confidence: pick.confidence,
        reason: extendedThinking ? "thinking_blocks_tool_choice" : undefined,
      };
    }
    return { mode: "passthrough", reason: "mode_not_allowed", confidence: pick.confidence };
  }

  // Force only tools the target can actually be forced into. A provider-run or
  // namespaced tool is not addressable through tool_choice.
  const plan = plans.find((p) => p.name === pick.choice);
  if (plan && plan.kind && plan.kind !== "function") {
    return { mode: "passthrough", reason: "hosted_tool_selected", confidence: pick.confidence };
  }
  return { mode: "forced", tool: pick.choice, confidence: pick.confidence };
}
