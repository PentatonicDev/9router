// App-side glue: reads the operator's settings, resolves the gateway credential, and
// turns jev's answers into an ordered model list or a tool mode. The gateway IS the
// provider, so one key covers chat and decisions. Swapping the decision model is
// editing `model`.
//
// The pure parts live in open-sse/decision/ and import nothing from src/.

import { createHash } from "node:crypto";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getProviderCredentials } from "./auth.js";
import { askJev, decisionUrlFor } from "open-sse/decision/jev.js";
import { buildState } from "open-sse/decision/state.js";
import { buildModelQuestions, buildToolQuestions, shortlistTools } from "open-sse/decision/questions.js";
import { resolveModelDecision, resolveToolDecision } from "open-sse/decision/decide.js";
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { resolveCriteria } from "open-sse/decision/modelBriefs.js";
import { rankByCost } from "open-sse/decision/decide.js";
import { getModelInfo } from "./model.js";
import { DECISION_PRESETS, decisionPreset } from "open-sse/decision/presets.js";

export const DEFAULT_DECISION = {
  mode: "off",
  provider: "vercel-ai-gateway",
  model: "typesafe-ai/jev",
  preset: "balanced",
  ...DECISION_PRESETS.balanced,
  timeoutMs: 1500,
};

export function normalizeDecisionConfig(raw) {
  const config = { ...DEFAULT_DECISION, ...(raw || {}) };
  const preset = decisionPreset(config.preset);
  return {
    ...config,
    preset,
    ...DECISION_PRESETS[preset],
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_DECISION.timeoutMs,
  };
}

/** The raw registry entry, which carries `transport` and `systemoneConfig`. */
function registryEntry(providerId) {
  return REGISTRY.find((entry) => entry.id === providerId || entry.alias === providerId) || null;
}

/** Gateways that can serve a decision model. */
export function decisionProviders() {
  return REGISTRY.filter((entry) => entry.systemoneConfig && entry.transport)
    .map((entry) => ({
      id: entry.id,
      name: entry.display?.name || entry.id,
      defaultModel: entry.systemoneConfig.defaultModel || null,
      modelType: entry.systemoneConfig.modelType || null,
    }));
}

/**
 * Resolve everything needed to ask the decision model, or null.
 *
 * The lock key is namespaced per gateway: without its own scope the account
 * breaker would take the shared chat provider offline for chat too.
 */
export async function resolveDecisionTarget(config, { apiKey = null, allowedConnectionIds = null, comboOwner = null, settings, log } = {}) {
  const entry = registryEntry(config.provider);
  const url = decisionUrlFor(entry);
  if (!url) {
    log?.warn?.("DECISION", `${config.provider} declares no decision route`);
    return null;
  }
  const lockKey = `decision:${entry.id}`;
  try {
    const credentials = await getProviderCredentials(entry.id, new Set(), lockKey, {
      apiKey, allowedConnectionIds, keyOwner: comboOwner, settings,
    });
    if (credentials?.noActiveCredentials) {
      log?.info?.("DECISION", `no active credentials for ${entry.id} - decisions disabled`);
      return null;
    }
    const key = credentials?.apiKey || credentials?.accessToken || null;
    if (!key) return null;
    log?.info?.("DECISION", `using ${entry.id} credential for the decision route`);
    return {
      url,
      apiKey: key,
      provider: entry.id,
      // The account and the caller that caused the decision, so its usage row lands
      // under them instead of reading as an unattributed local call.
      connectionId: credentials?.connectionId || null,
      callerApiKey: apiKey,
    };
  } catch (error) {
    log?.warn?.("DECISION", `credential lookup failed: ${error.message}`);
    return null;
  }
}

/** What each model is FOR, without its price: the decision model is asked to judge
 *  fitness only. Costs are compared later, and only among the models it rated alike. */
function criteriaResolver(config) {
  return (model) => {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "";
    const id = slash > 0 ? model.slice(slash + 1) : model;
    return resolveCriteria({ provider, model: id, briefs: config.briefs });
  };
}

/** Input price per million tokens. The pool carries provider ALIASES ("br/…"),
 *  and the pricing tables are keyed by provider id ("bedrock/…") — passing the
 *  alias silently returns null, which would sort a $5 Opus to the bottom of the
 *  pool as if it were unpriced. Null only when the model is genuinely unlisted. */
export function priceOf(model) {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const price = getPricingForModel(model.slice(0, slash), model.slice(slash + 1));
  return typeof price?.input === "number" ? price.input : null;
}

/**
 * The decision pool: every model the combo can really reach, cheapest first.
 *
 * A combo-of-combos lists tier names, not models, and a name carries no price —
 * PATTERN_PRICING's `claude-*` catch-all would give a combo called "claude-auto"
 * a $3 that means nothing. So each nested combo is expanded to its own members and
 * the pick is made among the models themselves, which is the whole point: within
 * those members there is a best one for this task.
 *
 * Order of first appearance is kept and duplicates dropped — the same cheap
 * fallback sits in several tiers, and listing it three times would weight the
 * ranking toward it.
 *
 * ponytail: one level of nesting, which is the depth the combo editor can build.
 * A deeper tree keeps the inner combo as one entry rather than recursing.
 */
export async function rankPool(models, resolveMember) {
  const expanded = [];
  for (const model of models) {
    if (model.includes("/")) { expanded.push(model); continue; }
    const members = (await resolveMember(model)) || [];
    expanded.push(...(members.length ? members : [model]));
  }
  const unique = [...new Set(expanded)];
  return rankByCost(unique, priceOf);
}

// ponytail: one availability read per candidate; batch by provider if this enters the routing latency budget.
export async function availableDecisionPool(ranked, { apiKey, settings, comboOwner, allowedConnectionIds } = {}) {
  const inspected = await Promise.all(ranked.map(async (name) => {
    const { provider, model } = await getModelInfo(name, comboOwner);
    if (!provider) return { name, available: false, cost: priceOf(name) };
    const status = await getProviderCredentials(provider, null, model, {
      apiKey, settings, keyOwner: comboOwner === undefined ? null : comboOwner,
      allowedConnectionIds: allowedConnectionIds ?? null,
      inspectOnly: true,
    });
    const available = status.available === true;
    const cost = status.subscription || status.free ? 0 : (priceOf(name) ?? Infinity);
    return { name, available, cost };
  }));
  const available = inspected.filter(item => item.available);
  if (!available.length) return { pool: [], costOf: priceOf };
  const costs = new Map(available.map(({ name, cost }) => [name, cost]));
  const costOf = (name) => costs.has(name) ? costs.get(name) : priceOf(name);
  return { pool: rankByCost(available.map(item => item.name), costOf), costOf };
}

/** Whether the request carries an Anthropic `thinking` block. Anthropic refuses a
 *  pinned tool_choice in that mode ("Thinking mode does not support this
 *  tool_choice"). The test is the field itself, not the intent: an OpenAI target
 *  gets `reasoning_effort`, which places no such restriction on tool_choice. */
function hasAnthropicThinking(body) {
  const type = body?.thinking?.type;
  return typeof type === "string" && type !== "disabled";
}

/** Deliberation at or above this makes an abstention defer to the next tier up. */
export const DEFER_DELIBERATION = 0.5;

/**
 * An abstention on a step that needs thought should not leave the pool's cheapest
 * model serving it by default. The candidates are cheapest-first, so the one after
 * the cheapest is the next tier up. Null when the verdict was not usable at all or
 * the step reads as mechanical — then the pool order stands.
 */
const DOUBT = ["no_favourite", "awaiting_confirmation", "signals_disagree"];

export function deferUpOnDoubt(decision, candidates) {
  if (!DOUBT.includes(decision?.reason)) return null;
  if (!(decision.deliberation >= DEFER_DELIBERATION)) return null;
  return candidates[1] || null;
}

/**
 * A session already escalated keeps its tier through a turn jev cannot call. Mid-session
 * states read as tool traffic and jev abstains on most of them; dropping to the pool
 * head there sent hard tasks back to the cheapest model (measured: s o o o s o s s h h
 * on a task the escalated turns were solving) and rewrote the prompt cache each time.
 * A clear verdict still moves the session either way — only doubt holds.
 */
export function holdOnDoubt(decision, held, candidates) {
  if (!DOUBT.includes(decision?.reason)) return null;
  return held && held !== candidates[0] && candidates.includes(held) ? held : null;
}

export function decisionCandidates(pool) {
  const byBase = new Map();
  for (const model of pool) {
    const base = /^(?:kr|kiro)\//.test(model)
      ? model.replace(/-(?:thinking-agentic|thinking|agentic)$/, "")
      : model;
    if (!byBase.has(base) || model === base) byBase.set(base, model);
  }
  return [...byBase.values()];
}

const ask = (target, config, state, questions, log) =>
  askJev({
    url: target.url,
    model: config.model,
    apiKey: target.apiKey,
    state,
    questions,
    timeoutMs: config.timeoutMs,
    onFailure: (reason) => log?.info?.("DECISION", `decision model returned nothing (${reason})`),
  }).then((response) => (response ? { ...response, state, questions } : response));

/**
 * Auto-combo: which model of the pool should serve this turn.
 *
 * The conversation is read from the RAW client body, because by the time the body
 * is translated the target provider is fixed and the model can no longer change
 * in this request.
 *
 * Returns the pool reordered with the pick first, or the pool unchanged. An
 * unapplied decision is not an error: the caller's fallback loop walks the rest of
 * the list, so a wrong pick costs one attempt rather than a failure.
 */
export async function decideComboModel({ body, models, comboName, config, target, log, previousVerdict = null, held = null, ranked = null, costOf = priceOf, fallback = null }) {
  // Cheapest first, and the list both the question and the verdict are served from.
  // The question MUST be built over this pool: for a combo-of-combos `models` holds
  // tier names, so asking with those and validating against the expanded pool has
  // jev answer a tier name the pool does not contain — every verdict discarded as
  // `no_usable_pick`, measured at 243 of 243 calls.
  const pool = ranked?.length ? ranked : rankByCost(models, costOf);
  if (pool.length < 2) return { models, decision: null };

  const candidates = decisionCandidates(pool);
  if (candidates.length < 2) return { models, decision: null };
  const { questions } = buildModelQuestions(candidates, criteriaResolver(config));
  const state = buildState(body, { maxStateChars: 24000 });
  const response = await ask(target, config, state, questions, log);

  if (!response) {
    log?.info?.("DECISION", "model: verdict discarded, pool order unchanged");
    return { models, decision: null, reason: "ask_failed" };
  }

  const decision = resolveModelDecision({
    answers: response.answers,
    models: candidates,
    priceOf: costOf,
    hardTaskPriceOf: priceOf,
    minStrength: config.minStrength,
    switchStrength: config.switchStrength,
    previousVerdict,
  });

  await recordUsage({ response, log, target, verdict: verdictMeta(decision, { kind: "model", comboName }) });

  if (!decision.apply) {
    const tier = (model) => candidates.indexOf(model);
    const deferred = deferUpOnDoubt(decision, candidates);
    const kept = holdOnDoubt(decision, held, candidates);
    const up = kept && (!deferred || tier(kept) > tier(deferred)) ? kept : deferred;
    if (up) {
      const reason = up === kept ? "held" : "deferred_up";
      log?.info?.("DECISION", `model: ${up} for "${comboName}" (${reason}: ${decision.reason}, deliberar ${fmt(decision.deliberation)}, ${response.latencyMs}ms)`);
      return {
        models: [up, ...pool.filter((m) => m !== up), ...(fallback || [])],
        decision: { ...decision, deferredTo: up },
        reason,
      };
    }
    log?.info?.("DECISION", `model: no change (${decision.reason}, strength ${fmt(decision.strength)}, ${response.latencyMs}ms)`);
    return { models, decision, reason: decision.reason };
  }

  log?.info?.(
    "DECISION",
    `model: ${decision.model} for "${comboName}" (strength ${fmt(decision.strength)}, deliberar ${fmt(decision.deliberation)}, ${response.latencyMs}ms)`
  );
  return { models: [decision.model, ...pool.filter((m) => m !== decision.model), ...(fallback || [])], decision };
}

/**
 * Tool routing: which tool the model should call next, if any. The caller decides
 * whether to apply it, which is what makes shadow mode measurable.
 */
export async function decideTool({ body, tools, plans = [], config, target, log }) {
  if (tools.length === 0) return null;

  const kept = shortlistTools(tools, body);
  const { questions } = buildToolQuestions(kept);
  // A much smaller window than the model decision uses: the conversation dominates
  // a decision's cost (~3,400 of 4,442 input tokens at 30 turns, against ~740 for a
  // 21-tool roster) and "what next" needs the latest request, not the whole
  // transcript. Runs once per turn and is the verdict most often discarded.
  // ponytail: fixed ceiling; raise it if long sessions start picking worse.
  const state = buildState(body, { maxStateChars: 6000 });
  const response = await ask(target, config, state, questions, log);
  if (!response) return null;

  const toolDecision = resolveToolDecision({
    answers: response.answers,
    tools: kept.map((t) => t.name),
    plans,
    allowed: config.toolMode,
    minConfidence: config.minConfidence,
    // A pinned tool_choice is rejected upstream while thinking is on, so the
    // verdict is capped to a hint there rather than turning into a 400.
    extendedThinking: hasAnthropicThinking(body),
  });
  await recordUsage({ response, log, target, verdict: verdictMeta(toolDecision, { kind: "tool", tools: kept.length }) });

  return { ...toolDecision, latencyMs: response.latencyMs };
}

/**
 * Its own usage row, under its own model: folded into the main request these tokens
 * would be priced at the serving model's rate. PROVIDER_PRICING's `typesafe` entry
 * is what lets calculateCost price them at all.
 *
 * The row carries the verdict in `meta`, so the table answers "why did this request
 * reach an expensive model" and not only "how much did it spend".
 */
async function recordUsage({ response, log, verdict, target }) {
  try {
    const { saveRequestUsage } = await import("@/lib/db/index.js");
    await saveRequestUsage({
      provider: target?.provider || "typesafe",
      model: response.model || "jev-latest",
      endpoint: "decision",
      connectionId: target?.connectionId || null,
      apiKey: target?.callerApiKey || null,
      tokens: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
      meta: verdict ? { ...verdict, route: response.route, via: target?.provider || null } : undefined,
    });
    await saveDecisionDetail({ response, verdict, target });
  } catch (error) {
    log?.debug?.("DECISION", `usage not recorded: ${error.message}`);
  }
}

async function saveDecisionDetail({ response, verdict, target }) {
  const questions = response.questions;
  try {
    const { saveRequestDetail } = await import("@/lib/usageDb.js");
    const { buildRequestDetail, buildDecisionDetail } = await import("open-sse/handlers/chatCore/requestDetail.js");
    const answers = response.answers || {};
    const probabilities = {};
    for (const [k, v] of Object.entries(answers)) {
      if (v?.probabilities) probabilities[k] = v.probabilities;
    }
    await saveRequestDetail(buildRequestDetail({
      provider: target?.provider || "typesafe",
      model: response.model || "jev-latest",
      connectionId: target?.connectionId || undefined,
      apiKey: target?.callerApiKey || undefined,
      latency: { ttft: null, total: response.latencyMs ?? null },
      tokens: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
      request: { kind: verdict?.kind || null, questions: questions || null },
      decisionState: response.state || null,
      endpoint: "decision",
      providerRequest: { model: response.model, route: response.route?.canonicalSlug || null },
      providerResponse: { answers, probabilities },
      response: { verdict: verdict || null },
      decision: verdict
        ? buildDecisionDetail(verdict.kind === "model" ? verdict : null, verdict.kind === "tool" ? verdict : null)
        : undefined,
      status: "success",
    }));
  } catch (error) {
    // log may not be in scope here; fail silently.
  }
}

/** The last verdict per combo, so a repeated answer can unlock the ambiguous band.
 *  ponytail: in-process, so the streak is per instance — same ceiling as
 *  comboRotationState. Move both to the shared store together, not separately. */
const lastVerdicts = new Map();

export function readPreviousVerdict(key) {
  return lastVerdicts.get(key) || null;
}

export function rememberVerdict(key, decision) {
  if (!key) return;
  if (decision?.model) lastVerdicts.set(key, decision.model);
  else lastVerdicts.delete(key);
}

/** The model each session was last served, keyed by combo + the session's first user
 *  turn — the only turn that stays the same while a session runs. Keyed by combo alone,
 *  two concurrent sessions would hold each other's tier.
 *  ponytail: in-process and capped at MAX_SESSIONS, oldest evicted; same ceiling as
 *  lastVerdicts. */
const servedBySession = new Map();
const MAX_SESSIONS = 1000;

export function sessionKey(comboName, body) {
  const turns = body?.messages || body?.input || body?.contents || [];
  const anchor = turns.find((msg) => msg?.role === "user");
  if (!comboName || !anchor) return null;
  const text = JSON.stringify(anchor.content ?? anchor.parts ?? "");
  return `${comboName}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

export function readHeld(key) {
  return (key && servedBySession.get(key)) || null;
}

export function rememberServed(key, model) {
  if (!key || !model) return;
  servedBySession.delete(key);
  servedBySession.set(key, model);
  if (servedBySession.size > MAX_SESSIONS) servedBySession.delete(servedBySession.keys().next().value);
}

export function resetVerdicts() {
  lastVerdicts.clear();
  servedBySession.clear();
}

/**
 * What a decision row records about itself. Small and flat: it lands in a JSON column
 * read per row, so it carries the answer and the reason, never the whole pool.
 */
function verdictMeta(decision, extra = {}) {
  if (!decision) return undefined;
  const round = (v) => (typeof v === "number" ? Number(v.toFixed(3)) : null);
  return {
    ...extra,
    apply: decision.apply === true,
    reason: decision.reason || null,
    model: decision.model || null,
    // Set when the cost tie-break moved the pick off jev's own answer, so a
    // cheaper route can still be traced to the verdict it came from.
    downgradedFrom: decision.downgradedFrom || null,
    tool: decision.tool || null,
    mode: decision.mode || null,
    confidence: round(decision.confidence),
    strength: round(decision.strength),
    deliberation: round(decision.deliberation),
  };
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "-");
