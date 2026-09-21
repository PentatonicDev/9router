// App-side glue: reads the operator's settings, resolves the gateway credential, and
// turns jev's answers into an ordered model list or a tool mode. The gateway IS the
// provider, so one key covers chat and decisions. Swapping the decision model is
// editing `model`.
//
// The pure parts live in open-sse/decision/ and import nothing from src/.

import REGISTRY from "open-sse/providers/registry/index.js";
import { getProviderCredentials } from "./auth.js";
import { askJev, decisionUrlFor } from "open-sse/decision/jev.js";
import { buildState, hasCacheBreakpoint } from "open-sse/decision/state.js";
import { buildModelQuestions, buildToolQuestions } from "open-sse/decision/questions.js";
import { resolveModelDecision, resolveToolDecision } from "open-sse/decision/decide.js";
import { resolveCriteria } from "open-sse/decision/modelBriefs.js";

export const DEFAULT_DECISION = {
  mode: "off",
  provider: "vercel-ai-gateway",
  model: "typesafe-ai/jev",
  models: [],
  briefs: {},
  toolMode: "hint",
  minConfidence: 0.7,
  switchConfidence: 0.85,
  timeoutMs: 1500,
};

export function normalizeDecisionConfig(raw) {
  const config = { ...DEFAULT_DECISION, ...(raw || {}) };
  if (!Array.isArray(config.models)) config.models = [];
  if (!config.briefs || typeof config.briefs !== "object") config.briefs = {};
  if (!Number.isFinite(config.timeoutMs)) config.timeoutMs = DEFAULT_DECISION.timeoutMs;
  return config;
}

/** The raw registry entry, which carries `transport` and `decisionConfig`. */
function registryEntry(providerId) {
  return REGISTRY.find((entry) => entry.id === providerId || entry.alias === providerId) || null;
}

/** Gateways that can serve a decision model. */
export function decisionProviders() {
  return REGISTRY.filter((entry) => entry.decisionConfig && entry.transport)
    .map((entry) => ({
      id: entry.id,
      name: entry.display?.name || entry.id,
      defaultModel: entry.decisionConfig.defaultModel || null,
      modelType: entry.decisionConfig.modelType || null,
    }));
}

/**
 * Is this request allowed to route through the decision model?
 *
 * The allowlist holds both shapes the model picker emits: `provider/model` for a
 * model, and a bare combo name for a combo. A bare name is unambiguous — the
 * runtime already separates the two by the presence of a slash
 * (getComboModelsFromData), so the same rule applies here.
 */
export function isDecisionAllowed(config, { provider, model, comboName } = {}) {
  if (!config || config.mode === "off") return false;
  if (config.models.length === 0) return false;
  if (comboName && config.models.includes(comboName)) return true;
  if (provider && model && config.models.includes(`${provider}/${model}`)) return true;
  return false;
}

/**
 * Resolve everything needed to ask the decision model, or null.
 *
 * The lock key is namespaced per gateway: without its own scope the account
 * breaker would take the shared chat provider offline for chat too.
 */
export async function resolveDecisionTarget(config, { apiKey = null, log } = {}) {
  const entry = registryEntry(config.provider);
  const url = decisionUrlFor(entry);
  if (!url) {
    log?.warn?.("DECISION", `${config.provider} declares no decision route`);
    return null;
  }
  const lockKey = `decision:${entry.id}`;
  try {
    const credentials = await getProviderCredentials(entry.id, new Set(), lockKey, { apiKey });
    if (credentials?.noActiveCredentials) {
      log?.info?.("DECISION", `no active credentials for ${entry.id} - decisions disabled`);
      return null;
    }
    const key = credentials?.apiKey || credentials?.accessToken || null;
    if (!key) return null;
    log?.info?.("DECISION", `using ${entry.id} credential for the decision route`);
    return { url, apiKey: key, provider: entry.id };
  } catch (error) {
    log?.warn?.("DECISION", `credential lookup failed: ${error.message}`);
    return null;
  }
}

function criteriaResolver(config) {
  return (model) => {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "";
    const id = slash > 0 ? model.slice(slash + 1) : model;
    return resolveCriteria({ provider, model: id, briefs: config.briefs });
  };
}

function priceOf(model) {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const id = slash > 0 ? model.slice(slash + 1) : model;
  const match = resolveCriteria({ provider, model: id }).match(/\$([\d.]+)\/M in/);
  return match ? Number(match[1]) : null;
}

function cheapestOf(models) {
  let cheapest = null;
  let lowest = Infinity;
  for (const model of models) {
    const price = priceOf(model);
    if (price !== null && price < lowest) {
      lowest = price;
      cheapest = model;
    }
  }
  return cheapest;
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
  });

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
export async function decideComboModel({ body, models, comboName, config, target, log, previousVerdict = null }) {
  if (models.length < 2) return { models, decision: null };

  const { questions } = buildModelQuestions(models, criteriaResolver(config));
  const state = buildState(body, { maxStateChars: 24000 });
  const response = await ask(target, config, state, questions, log);

  if (!response) {
    log?.info?.("DECISION", "model: verdict discarded, pool order unchanged");
    return { models, decision: null, reason: "ask_failed" };
  }
  await recordUsage({ response, log });

  const decision = resolveModelDecision({
    answers: response.answers,
    models,
    cheapest: cheapestOf(models),
    minConfidence: config.minConfidence,
    switchConfidence: config.switchConfidence,
    previousVerdict,
  });

  if (!decision.apply) {
    log?.info?.("DECISION", `model: no change (${decision.reason}, conf ${fmt(decision.confidence)}, ${response.latencyMs}ms)`);
    return { models, decision, reason: decision.reason };
  }

  log?.info?.(
    "DECISION",
    `model: ${decision.model} for "${comboName}" (conf ${fmt(decision.confidence)}, deliberar ${fmt(decision.deliberation)}, ${response.latencyMs}ms)`
  );
  return { models: [decision.model, ...models.filter((m) => m !== decision.model)], decision };
}

/**
 * Tool routing: which tool the model should call next, if any. The caller decides
 * whether to apply it, which is what makes shadow mode measurable.
 */
export async function decideTool({ body, tools, plans = [], config, target, log }) {
  if (tools.length === 0) return null;

  const { questions } = buildToolQuestions(tools);
  // A much smaller window than the model decision uses: the conversation dominates
  // a decision's cost (~3,400 of 4,442 input tokens at 30 turns, against ~740 for a
  // 21-tool roster) and "what next" needs the latest request, not the whole
  // transcript. Runs once per turn and is the verdict most often discarded.
  // ponytail: fixed ceiling; raise it if long sessions start picking worse.
  const state = buildState(body, { maxStateChars: 6000 });
  const response = await ask(target, config, state, questions, log);
  if (!response) return null;
  await recordUsage({ response, log });

  const cacheSafe = !hasCacheBreakpoint(body);
  return {
    ...resolveToolDecision({
      answers: response.answers,
      tools: tools.map((t) => t.name),
      plans,
      cacheSafe,
      allowed: config.toolMode,
      minConfidence: config.minConfidence,
    }),
    latencyMs: response.latencyMs,
    cacheSafe,
  };
}

/**
 * Its own usage row, under its own model: folded into the main request these tokens
 * would be priced at the serving model's rate. PROVIDER_PRICING's `typesafe` entry
 * is what lets calculateCost price them at all.
 */
async function recordUsage({ response, log }) {
  try {
    const { saveRequestUsage } = await import("@/lib/db/index.js");
    await saveRequestUsage({
      provider: "typesafe",
      model: response.model || "jev-latest",
      endpoint: "decision",
      tokens: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    log?.debug?.("DECISION", `usage not recorded: ${error.message}`);
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

export function resetVerdicts() {
  lastVerdicts.clear();
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "-");
