// Amazon Bedrock — quota + today's-token-consumption snapshot for one
// connection, feeding the dashboard's Quota Tracker. Two AWS control planes,
// both optional and both fail-open (mirrors bedrockModels.js): Service Quotas
// for the published caps, CloudWatch (namespace AWS/Bedrock) for what the
// connection actually burned today. Any failure degrades to a partial
// snapshot with an `errors` entry — this module never throws.
import { ServiceQuotasClient, ListServiceQuotasCommand } from "@aws-sdk/client-service-quotas";
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { buildBedrockClientConfig } from "./bedrockClient.js";
import { BEDROCK_INFERENCE_PROFILE_PREFIXES, bedrockCanonicalModelName } from "../providers/bedrockGeoPrefix.js";

const QUOTA_CACHE_TTL_MS = 10 * 60 * 1000;
const METRICS_CACHE_TTL_MS = 60 * 1000;
const BEDROCK_SERVICE_CODE = "bedrock";
const METRIC_NAMESPACE = "AWS/Bedrock";
const MAX_METRIC_QUERIES_PER_CALL = 500;
const ACCOUNT_DAILY_QUOTA_NAME = "cross-model account-level tokens per day";

const quotaCache = new Map();
const metricsCache = new Map();

function humanizeAwsError(err, context) {
  const name = err?.name || "Error";
  const message = err?.message || String(err) || "Unknown error";
  if (name === "AccessDeniedException" || name === "UnauthorizedException") {
    const action = context === "quotas"
      ? "servicequotas:ListServiceQuotas / servicequotas:GetServiceQuota"
      : "cloudwatch:GetMetricData / cloudwatch:GetMetricStatistics";
    return `Not authorized to read Bedrock ${context} — this IAM user needs ${action} (${name}).`;
  }
  if (["UnrecognizedClientException", "ExpiredTokenException", "InvalidSignatureException"].includes(name)) {
    return `AWS credentials were rejected while reading Bedrock ${context} (${name}).`;
  }
  return `Failed to read Bedrock ${context}: ${message} (${name})`;
}

// "global.anthropic.claude-opus-4-6-v1" -> "opus 4.6", "anthropic.claude-3-5-
// haiku-20241022-v1:0" -> "3.5 haiku", "amazon.nova-pro-v1:0" -> "nova pro".
// Anchors the version token to word order (family word before or after the
// numbers, matching Bedrock's own naming) so the label can be matched against
// a quota's free-text name without inventing a lookup table per model.
export function deriveBedrockFamilyLabel(modelId) {
  const canonical = bedrockCanonicalModelName(modelId) || "";
  const noDate = canonical.replace(/-\d{8}$/, "");
  if (!noDate.startsWith("claude")) return noDate.replace(/-/g, " ").toLowerCase();

  const tokens = noDate.replace(/^claude-?/, "").split("-").filter(Boolean);
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  const numbers = tokens.filter((t) => /^\d+$/.test(t));
  if (!words.length) return numbers.join(".");
  const version = numbers.join(".");
  const wordComesFirst = tokens.findIndex((t) => !/^\d+$/.test(t)) === 0;
  const word = words.join(" ");
  return (wordComesFirst ? `${word} ${version}` : `${version} ${word}`).trim();
}

function deriveBedrockScope(modelId) {
  const firstSegment = String(modelId || "").split(".")[0];
  if (firstSegment === "global") return "global";
  if (BEDROCK_INFERENCE_PROFILE_PREFIXES.includes(firstSegment)) return "regional";
  return "bare";
}

// Per-scope quota-name prefixes (lowercased), exact enough that "global cross-
// region ..." never satisfies the plain "cross-region ..." (regional) prefix.
const SCOPE_QUOTA_PREFIXES = {
  global: {
    daily: "global cross-region model inference tokens per day",
    tpm: "global cross-region model inference tokens per minute",
    rpm: "global cross-region model inference requests per minute",
  },
  regional: {
    daily: "cross-region model inference tokens per day",
    tpm: "cross-region model inference tokens per minute",
    rpm: "cross-region model inference requests per minute",
  },
  bare: {
    daily: "model invocation max tokens per day",
    tpm: "on-demand model inference tokens per minute",
    rpm: "on-demand model inference requests per minute",
  },
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match with a guard against "sonnet 5" matching inside
// "sonnet 5.1": a trailing version number must not be followed by ".digit".
function familyLabelRegex(family) {
  return new RegExp(`\\b${escapeRegExp(family)}\\b(?!\\.\\d)`, "i");
}

// Several quotas can carry the same family ("Sonnet 4.5 V1" and "Sonnet 4.5 V1
// 1M Context Length"); the plain model is the shortest name, the variants add
// qualifiers, so the shortest match wins.
function matchQuota(quotas, scope, kind, family) {
  const prefix = SCOPE_QUOTA_PREFIXES[scope]?.[kind];
  if (!prefix) return null;
  const regex = familyLabelRegex(family);
  let best = null;
  for (const q of quotas) {
    const name = String(q.QuotaName || "").toLowerCase();
    if (!name.startsWith(prefix) || !regex.test(name)) continue;
    if (!best || name.length < String(best.QuotaName).length) best = q;
  }
  return best;
}

function quotasForModel(quotas, modelId) {
  const scope = deriveBedrockScope(modelId);
  const family = deriveBedrockFamilyLabel(modelId);
  const daily = matchQuota(quotas, scope, "daily", family);
  const tpm = matchQuota(quotas, scope, "tpm", family);
  const rpm = matchQuota(quotas, scope, "rpm", family);
  return {
    dailyQuota: daily ? daily.Value : null,
    dailyQuotaName: daily ? daily.QuotaName : null,
    tpmQuota: tpm ? tpm.Value : null,
    tpmQuotaName: tpm ? tpm.QuotaName : null,
    rpmQuota: rpm ? rpm.Value : null,
  };
}

function accountDailyQuota(quotas) {
  const q = quotas.find((q) => String(q.QuotaName || "").toLowerCase() === ACCOUNT_DAILY_QUOTA_NAME);
  return q ? q.Value : null;
}

async function fetchAllQuotas(client) {
  const quotas = [];
  let nextToken;
  do {
    const res = await client.send(new ListServiceQuotasCommand({ ServiceCode: BEDROCK_SERVICE_CODE, NextToken: nextToken }));
    quotas.push(...(res.Quotas || []));
    nextToken = res.NextToken;
  } while (nextToken);
  return quotas;
}

// ListServiceQuotas pages ~1,100 Bedrock quotas sequentially (measured 34s on a
// real account), far past what a tracker refresh should wait. The fetch runs
// with a time budget: past it, the caller gets the previous list (or none) and
// the in-flight fetch keeps filling the cache for the next refresh.
const QUOTA_FETCH_BUDGET_MS = 8000;
const quotaInflight = new Map();

async function getQuotasCached(client, cacheKey, errors) {
  const cached = quotaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.quotas;

  let inflight = quotaInflight.get(cacheKey);
  if (!inflight) {
    inflight = fetchAllQuotas(client)
      .then((quotas) => { quotaCache.set(cacheKey, { quotas, expiresAt: Date.now() + QUOTA_CACHE_TTL_MS }); return { quotas }; })
      .catch((err) => ({ error: humanizeAwsError(err, "quotas") }))
      .finally(() => quotaInflight.delete(cacheKey));
    quotaInflight.set(cacheKey, inflight);
  }

  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve({ pending: true }), QUOTA_FETCH_BUDGET_MS); });
  const result = await Promise.race([inflight, budget]);
  clearTimeout(timer);
  if (result.quotas) return result.quotas;
  if (result.error) errors.push(result.error);
  else errors.push("Bedrock quotas are still loading (first read of the account's quota list takes ~30s); refresh shortly.");
  return cached?.quotas || [];
}

async function listMetricModelIds(client, errors) {
  const ids = new Set();
  let nextToken;
  try {
    do {
      const res = await client.send(new ListMetricsCommand({
        Namespace: METRIC_NAMESPACE,
        MetricName: "InputTokenCount",
        NextToken: nextToken,
      }));
      for (const m of res.Metrics || []) {
        const dim = (m.Dimensions || []).find((d) => d.Name === "ModelId");
        if (dim?.Value) ids.add(dim.Value);
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch (err) {
    errors.push(humanizeAwsError(err, "metrics"));
  }
  return ids;
}

async function fetchMetricsForIds(client, ids, startTime, endTime, errors) {
  const tallies = new Map(ids.map((id) => [id, { inputTokens: 0, outputTokens: 0, invocations: 0 }]));
  if (ids.length === 0) return tallies;

  const METRIC_SPECS = [
    { suffix: "in", metricName: "InputTokenCount", field: "inputTokens" },
    { suffix: "out", metricName: "OutputTokenCount", field: "outputTokens" },
    { suffix: "cnt", metricName: "Invocations", field: "invocations" },
  ];
  const queryById = new Map();
  const allQueries = [];
  ids.forEach((modelId, idx) => {
    for (const spec of METRIC_SPECS) {
      const id = `q${idx}_${spec.suffix}`;
      allQueries.push({
        Id: id,
        MetricStat: {
          Metric: { Namespace: METRIC_NAMESPACE, MetricName: spec.metricName, Dimensions: [{ Name: "ModelId", Value: modelId }] },
          Period: 86400,
          Stat: "Sum",
        },
        ReturnData: true,
      });
      queryById.set(id, { modelId, field: spec.field });
    }
  });

  for (let i = 0; i < allQueries.length; i += MAX_METRIC_QUERIES_PER_CALL) {
    const chunk = allQueries.slice(i, i + MAX_METRIC_QUERIES_PER_CALL);
    try {
      const res = await client.send(new GetMetricDataCommand({ MetricDataQueries: chunk, StartTime: startTime, EndTime: endTime }));
      for (const r of res.MetricDataResults || []) {
        const meta = queryById.get(r.Id);
        if (!meta) continue;
        const sum = (r.Values || []).reduce((a, b) => a + b, 0);
        tallies.get(meta.modelId)[meta.field] += sum;
      }
    } catch (err) {
      errors.push(humanizeAwsError(err, "metrics"));
    }
  }
  return tallies;
}

async function getMetricsCached(client, cacheKey, modelIds, startTime, endTime, errors) {
  const cached = metricsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const discoveredIds = await listMetricModelIds(client, errors);
  const allIds = Array.from(new Set([...modelIds, ...discoveredIds]));
  const tallies = await fetchMetricsForIds(client, allIds, startTime, endTime, errors);
  const value = { tallies, discoveredIds };
  metricsCache.set(cacheKey, { value, expiresAt: Date.now() + METRICS_CACHE_TTL_MS });
  return value;
}

function utcDayStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * @returns {Promise<{
 *   region: string, dayStartIso: string, fetchedAt: string,
 *   account: { tokensToday: number, dailyQuota: number|null },
 *   models: Array<{ id: string, tokensToday: number, inputTokens: number, outputTokens: number,
 *     invocations: number, dailyQuota: number|null, dailyQuotaName: string|null,
 *     tpmQuota: number|null, tpmQuotaName: string|null, rpmQuota: number|null }>,
 *   errors: string[],
 * }>}
 */
export async function getBedrockQuotaSnapshot(credentials, { modelIds = [], now = new Date() } = {}) {
  const psd = credentials?.providerSpecificData || {};
  const region = psd.region === "global" ? (psd.homeRegion || "us-east-1") : (psd.region || "us-east-1");
  const dayStart = utcDayStart(now);
  const fetchedAt = new Date().toISOString();

  if (psd.authMethod !== "iam") {
    return {
      region,
      dayStartIso: dayStart.toISOString(),
      fetchedAt,
      account: { tokensToday: 0, dailyQuota: null },
      models: [],
      errors: ["Quota tracking needs IAM credentials — API-key (Bearer) Bedrock connections can't call Service Quotas / CloudWatch."],
    };
  }

  const errors = [];
  const clientConfig = buildBedrockClientConfig({ ...credentials, providerSpecificData: { ...psd, region } });
  const quotasClient = new ServiceQuotasClient(clientConfig);
  const cwClient = new CloudWatchClient(clientConfig);

  const credKey = psd.accessKeyId || "default";
  const quotas = await getQuotasCached(quotasClient, `${credKey}|${region}`, errors);

  const metricsCacheKey = `${credKey}|${region}|${dayStart.toISOString()}|${[...modelIds].sort().join(",")}`;
  const { tallies, discoveredIds } = await getMetricsCached(cwClient, metricsCacheKey, modelIds, dayStart, now, errors);

  const allIds = Array.from(new Set([...modelIds, ...discoveredIds]));
  const models = [];
  for (const id of allIds) {
    const t = tallies.get(id) || { inputTokens: 0, outputTokens: 0, invocations: 0 };
    if (t.invocations === 0 && !modelIds.includes(id)) continue;
    models.push({
      id,
      tokensToday: t.inputTokens + t.outputTokens,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      invocations: t.invocations,
      ...quotasForModel(quotas, id),
    });
  }

  const accountTokensToday = models.reduce((sum, m) => sum + m.tokensToday, 0);
  return {
    region,
    dayStartIso: dayStart.toISOString(),
    fetchedAt,
    account: { tokensToday: accountTokensToday, dailyQuota: accountDailyQuota(quotas) },
    models,
    errors,
  };
}

export function clearBedrockQuotaCache() {
  quotaCache.clear();
  metricsCache.clear();
}
