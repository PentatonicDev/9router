// System One (jev) transport. The decision model is a field, not a provider: the
// caller names the gateway that serves it and the model id, and this module only
// knows the wire format. Every route that resells jev takes the same body
// ({ model, state, questions }) and returns the same shape, so one client covers
// all of them — only the URL and the credential differ.
//
// Every entry point fails open: a decision provider is an optimisation, and an
// outage must never take a request down with it. Callers get null, not a throw.

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Decision models are advertised in a gateway's catalog with this type. */
export const DECISION_MODEL_TYPE = "evaluation";

/**
 * Where a decision model lives on a gateway: the configured path resolved against
 * the provider transport's origin, so adding a gateway never means hardcoding a
 * second host.
 */
export function decisionUrlFor(providerEntry) {
  const config = providerEntry?.decisionConfig;
  const base = providerEntry?.transport?.baseUrl;
  if (!config?.path || !base) return null;
  try {
    return new URL(config.path, base).toString();
  } catch {
    return null;
  }
}

/**
 * Gateways disagree on what a choice answer carries: TypeSafe's own API always
 * sends `confidence`, resellers sometimes send only `probabilities`. Without this
 * the caller's threshold reads `undefined` and every decision is discarded — a
 * silent total failure, not a degraded one. The winning probability is the honest
 * stand-in.
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
 * One call to the decision model. Returns null on any failure — including a
 * refusal to retry, which is the normal path for 401/422: repeating a rejected key
 * or a malformed body only doubles the latency before the same fail-open.
 */
export async function askJev({ url, model, apiKey, state, questions, timeoutMs = 3000, fetchImpl = fetch }) {
  if (!apiKey) return null;
  if (!url || !model) return null;
  if (!questions || Object.keys(questions).length === 0) return null;

  const startedAt = Date.now();
  const once = async () => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(`${response.status} from ${url}: ${detail.slice(0, 200)}`), {
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
    // A network error has no status and is worth the one retry; a 401/422 is not.
    // 503 is retryable because the Vercel route emits it intermittently —
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
    model: payload?.model || model,
    latencyMs: Date.now() - startedAt,
  };
}
