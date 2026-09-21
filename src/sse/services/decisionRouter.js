// App-side glue for the System One decision provider: reads the operator's
// settings, resolves the credential the route needs, and turns jev's answers into
// an ordered model list or a tool mode.
//
// Lives here rather than in open-sse/ because everything it touches — settings,
// provider connections, account locks — is app-side. open-sse/decision/ holds the
// pure parts (transport, state, questions, decide) and imports nothing from src/.

import { getProviderCredentials } from "./auth.js";
import { askJev, getRoute } from "open-sse/decision/jev.js";
import { buildState, hasCacheBreakpoint } from "open-sse/decision/state.js";
import { buildModelQuestions, buildToolQuestions } from "open-sse/decision/questions.js";
import { resolveModelDecision, resolveToolDecision } from "open-sse/decision/decide.js";
import { resolveCriteria } from "open-sse/decision/modelBriefs.js";
import { formatCost } from "open-sse/providers/pricing.js";

export const DEFAULT_DECISION = {
  mode: "off",
  route: "vercel",
  models: [],
  briefs: {},
  toolMode: "hint",
  minConfidence: 0.7,
  switchConfidence: 0.85,
  timeoutMs: 800,
};

export function normalizeDecisionConfig(raw) {
  const config = { ...DEFAULT_DECISION, ...(raw || {}) };
  if (!Array.isArray(config.models)) config.models = [];
  if (!config.briefs || typeof config.briefs !== "object") config.briefs = {};
  if (!Number.isFinite(config.timeoutMs)) config.timeoutMs = DEFAULT_DECISION.timeoutMs;
  return config;
}

/**
 * Is this request allowed to route through jev?
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
 * Resolve the key for the configured route. The route names the chat provider
 * whose connection already holds the credential, so one Vercel key serves both
 * chat and decisions and no second connection has to be registered.
 *
 * The lock key is route-scoped on purpose: without its own scope the account
 * breaker would take the shared chat provider offline for chat too.
 */
export async function resolveDecisionCredential(config, { apiKey = null, log } = {}) {
  const route = getRoute(config.route);
  const credentialProvider = route.credentialProvider || "jev";
  const lockKey = `decision:${credentialProvider}:${route.id}`;
  try {
    const credentials = await getProviderCredentials(credentialProvider, new Set(), lockKey, { apiKey });
    if (credentials?.noActiveCredentials) {
      log?.info?.("DECISION", `no active credentials for ${credentialProvider} - decisions disabled`);
      return null;
    }
    const key = credentials?.apiKey || credentials?.accessToken || null;
    if (key && credentialProvider !== "jev") {
      log?.info?.("DECISION", `using ${credentialProvider} credential for the ${route.id} route`);
    }
    return key ? { apiKey: key, credentialProvider, route } : null;
  } catch (error) {
    log?.warn?.("DECISION", `credential lookup failed: ${error.message}`);
    return null;
  }
}

function criteriaFor(models, config) {
  return (model) => {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "";
    const id = slash > 0 ? model.slice(slash + 1) : model;
    return resolveCriteria({ provider, model: id, briefs: config.briefs });
  };
}

function cheapestOf(models) {
  let cheapest = null;
  let lowest = Infinity;
  for (const model of models) {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "";
    const id = slash > 0 ? model.slice(slash + 1) : model;
    const criteria = resolveCriteria({ provider, model: id });
    const match = criteria.match(/\$([\d.]+)\/M in/);
    const price = match ? Number(match[1]) : null;
    if (price !== null && price < lowest) {
      lowest = price;
      cheapest = model;
    }
  }
  return cheapest;
}

/**
 * Auto-combo: which model of the pool should serve this turn.
 *
 * The conversation has to be read from the RAW client body, because by the time
 * the body is translated the target provider is already fixed and changing models
 * is no longer possible in this request.
 *
 * Returns the pool reordered with the pick first, or the pool unchanged. An
 * unapplied decision is not an error: the caller's fallback loop walks the rest of
 * the list, so a wrong pick costs one attempt rather than a failure.
 */
export async function decideComboModel({ body, models, comboName, config, apiKey, log, previousVerdict = null }) {
  if (models.length < 2) return { models, decision: null };
  const criteriaForModel = criteriaFor(models, config);
  const { questions } = buildModelQuestions(models, criteriaForModel);
  const state = buildState(body, { maxStateChars: 24000 });

  const startedAt = Date.now();
  const response = await askJev({
    state,
    questions,
    route: config.route,
    apiKey,
    timeoutMs: config.timeoutMs,
  });
  const latencyMs = Date.now() - startedAt;

  if (!response) {
    log?.info?.("DECISION", `model: jev unavailable, pool order unchanged (${latencyMs}ms)`);
    return { models, decision: null, reason: "ask_failed", latencyMs };
  }

  // Usage is recorded on its own line. Folding these tokens into the main request
  // would price them at the serving model's rate — an Opus-priced decision call.
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
    log?.info?.("DECISION", `model: no change (${decision.reason}, conf ${fmt(decision.confidence)}, ${latencyMs}ms)`);
    return { models, decision, reason: decision.reason, latencyMs };
  }

  log?.info?.(
    "DECISION",
    `model: ${decision.model} for "${comboName}" (conf ${fmt(decision.confidence)}, deliberar ${fmt(decision.deliberation)}, ${latencyMs}ms)`
  );
  return { models: [decision.model, ...models.filter((m) => m !== decision.model)], decision, latencyMs };
}

/**
 * Tool routing: which tool the model should call next, if any.
 *
 * `apply` is false in shadow mode, which is what makes the baseline measurable:
 * the call still happens and the decision is still logged and priced, it just is
 * not written into the request.
 */
export async function decideTool({ body, tools, plans = [], config, apiKey, log }) {
  if (tools.length === 0) return null;
  const { questions } = buildToolQuestions(tools);
  const state = buildState(body, { maxStateChars: 24000 });

  const startedAt = Date.now();
  const response = await askJev({
    state,
    questions,
    route: config.route,
    apiKey,
    timeoutMs: config.timeoutMs,
  });
  const latencyMs = Date.now() - startedAt;
  if (!response) return null;

  await recordUsage({ response, log });

  const cacheSafe = !hasCacheBreakpoint(body);
  const decision = resolveToolDecision({
    answers: response.answers,
    tools: tools.map((t) => t.name),
    plans,
    cacheSafe,
    allowed: config.toolMode,
    minConfidence: config.minConfidence,
  });

  return { ...decision, latencyMs, cacheSafe };
}

/**
 * The decision's own cost goes on its own usage row, under the decision provider's
 * own model. Folding these tokens into the main request would price them at the
 * serving model's rate — a decision call billed as Opus. `saveRequestUsage` runs
 * them through calculateCost, which is why PROVIDER_PRICING needs the `typesafe`
 * entry; without it the cost reads 0 and the savings maths is fiction.
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

/**
 * The last verdict per combo, so two identical answers can unlock the ambiguous
 * confidence band (0.7–0.85) that a single answer may not.
 *
 * ponytail: in-process, so in the distributed runtime the streak is per instance
 * and a load-balanced session may not see its own previous verdict. Same ceiling
 * the round-robin rotation already has (comboRotationState). Upgrade path: move
 * both to the shared store together, not separately.
 */
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

export { formatCost };
