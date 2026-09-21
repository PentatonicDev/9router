// TypeSafe "System One" (jev) transport. One body shape serves every route —
// { model, state, questions } in, { model, answers, usage } out — so a single
// fetch covers them; only the URL, model id and credential provider differ.
//
// Every entry point here fails open: a decision provider is an optimisation, and
// an outage must never take a request down with it. Callers get null, not a throw.

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Routes measured against the live API. `credentialProvider` names the chat
 *  provider whose connection already holds this route's key, so no second key
 *  has to be registered for the same account. */
export const ROUTES = {
  vercel: {
    id: "vercel",
    label: "Vercel AI Gateway",
    url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    model: "typesafe-ai/jev",
    credentialProvider: "vercel-ai-gateway",
  },
  typesafe: {
    id: "typesafe",
    label: "TypeSafe",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    credentialProvider: "jev",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/alpha/decisions",
    model: "typesafe/jev-1.13",
    credentialProvider: "openrouter",
  },
};

export const DEFAULT_ROUTE = "vercel";

export function getRoute(id) {
  return ROUTES[id] || ROUTES[DEFAULT_ROUTE];
}

/**
 * Gateways disagree on what a choice answer carries: TypeSafe's own API always
 * sends `confidence`, the resellers sometimes send only `probabilities`. Without
 * this the caller's threshold reads `undefined` and every decision is discarded —
 * a silent total failure, not a degraded one. The winning probability is the
 * honest stand-in.
 */
export function normalizeAnswers(answers) {
  const out = {};
  for (const [name, answer] of Object.entries(answers || {})) {
    if (!answer || typeof answer !== "object") continue;
    if (answer.type === "noul") {
      out[name] = { type: "noul", noul: Number(answer.noul) || 0 };
      continue;
    }
    const probs = answer.probabilities && typeof answer.probabilities === "object"
      ? Object.values(answer.probabilities).filter((v) => typeof v === "number")
      : [];
    const confidence = typeof answer.confidence === "number"
      ? answer.confidence
      : (probs.length ? Math.max(...probs) : 0);
    out[name] = { ...answer, confidence };
  }
  return out;
}

/**
 * One call to jev. Returns null on any failure — including a refusal to retry,
 * which is the normal path for 401/422: repeating a rejected key or a malformed
 * body only doubles the latency before the same fail-open.
 */
export async function askJev({
  state,
  questions,
  route = DEFAULT_ROUTE,
  apiKey,
  timeoutMs = 3000,
  fetchImpl = fetch,
  model,
}) {
  const entry = getRoute(route);
  if (!apiKey) return null;
  if (!questions || Object.keys(questions).length === 0) return null;

  const startedAt = Date.now();
  const once = async () => {
    const response = await fetchImpl(entry.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: model || entry.model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(`${response.status} from ${entry.label}: ${detail.slice(0, 200)}`), {
        status: response.status,
      });
    }
    return response.json();
  };

  let payload;
  try {
    payload = await once();
  } catch (error) {
    const status = error?.status;
    // A network error has no status, and is worth the one retry; a 401/422 is
    // not. 503 is retryable because the Vercel route emits it intermittently —
    // measured, not assumed.
    if (status !== undefined && !RETRYABLE.has(status)) return null;
    try {
      payload = await once();
    } catch {
      return null;
    }
  }

  const answers = normalizeAnswers(payload?.answers);
  if (Object.keys(answers).length === 0) return null;
  return {
    answers,
    usage: {
      input_tokens: payload?.usage?.input_tokens || 0,
      output_tokens: payload?.usage?.output_tokens || 0,
    },
    model: payload?.model || entry.model,
    route: entry.id,
    latencyMs: Date.now() - startedAt,
  };
}
