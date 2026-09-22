import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { maskApiKey } from "../helpers/maskKey.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    // The dashboard toggle (settings.enableObservability) owns this. ENABLE_REQUEST_LOGS
    // belongs to the debug file logs (open-sse/utils/requestLogger.js): "true" may still
    // force details on for a headless setup, but "false" must never veto the toggle —
    // it did, and a .env carrying ENABLE_REQUEST_LOGS=false silently dropped every row.
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    const envForcesOn = envRequestLogs !== undefined && envRequestLogs.toLowerCase() === "true";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? (settings.enableObservability || envForcesOn)
      : (envRequestLogs !== undefined ? envForcesOn : process.env.OBSERVABILITY_ENABLED !== "false");

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getDb();
      const config = await getObservabilityConfig();

      await db.transaction().execute(async (trx) => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);
          const isDecision = item.endpoint === "decision";

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            apiKeyMasked: maskApiKey(item.apiKey),
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            // Per-stage timings and the combo the request resolved through. Small
            // and flat, so they skip truncateField: losing them to a size cap would
            // defeat the point of measuring them.
            phases: item.phases || undefined,
            comboName: item.comboName || undefined,
            upstream: item.upstream || undefined,
            tokens: item.tokens || {},
            // A decision's request carries only the questions sent (bounded by
            // QUESTION_CHAR_BUDGET), so it skips the cap that exists for chat bodies
            // — those are unbounded (1.5MB measured) and would otherwise fill storage.
            request: isDecision ? (item.request || null) : truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
            // What the decision provider chose and why. Built by buildRequestDetail
            // but dropped here until now, which left every decision row showing
            // "Decision: null" and the apply rate unmeasurable.
            decision: item.decision || undefined,
            // The `state` the decision model was shown — the input that produced the
            // reported confidence. Bounded by maxStateChars upstream, so it skips
            // truncateField: a preview of a system prompt carries no signal.
            decisionState: item.decisionState || undefined,
          };

          const values = {
            id: record.id, timestamp: record.timestamp, provider: record.provider,
            model: record.model, connectionId: record.connectionId,
            apiKey: item.apiKey || null, status: record.status, data: stringifyJson(record),
          };
          await trx.insertInto("requestDetails").values(values)
            .onConflict((oc) => oc.column("id").doUpdateSet({
              timestamp: values.timestamp, provider: values.provider, model: values.model,
              connectionId: values.connectionId, apiKey: values.apiKey,
              status: values.status, data: values.data,
            }))
            .execute();
        }

        const cnt = await trx.selectFrom("requestDetails")
          .select((eb) => eb.fn.countAll().as("c")).executeTakeFirst();
        const total = Number(cnt?.c ?? 0);
        if (total > config.maxRecords) {
          // Oldest-first pruning keeps the newest maxRecords rows.
          const stale = await trx.selectFrom("requestDetails").select("id")
            .orderBy("timestamp", "asc").limit(total - config.maxRecords).execute();
          if (stale.length) {
            await trx.deleteFrom("requestDetails")
              .where("id", "in", stale.map((r) => r.id)).execute();
          }
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getDb();

  // Same predicate for the count and the page, so they cannot drift apart.
  const applyFilters = (q) => {
    if (filter.provider) q = q.where("provider", "=", filter.provider);
    if (filter.model) q = q.where("model", "=", filter.model);
    if (filter.connectionId) q = q.where("connectionId", "=", filter.connectionId);
    if (filter.apiKey) q = q.where("apiKey", "=", filter.apiKey);
    // Visibility scoping (owner-restricted callers): both forms coexist, the
    // single-value ones above stay for the dashboard route's explicit query params.
    // NULL apiKey/connectionId means unattributed/local traffic, which
    // canSeeUsageRow() treats as visible to everyone — so NULL rows must pass
    // this filter too, not just rows matching the visible id list.
    if (filter.apiKeys?.length) {
      q = q.where((eb) => eb.or([eb("apiKey", "is", null), eb("apiKey", "in", filter.apiKeys)]));
    }
    if (filter.connectionIds?.length) {
      q = q.where((eb) => eb.or([eb("connectionId", "is", null), eb("connectionId", "in", filter.connectionIds)]));
    }
    if (filter.status) q = q.where("status", "=", filter.status);
    if (filter.startDate) q = q.where("timestamp", ">=", new Date(filter.startDate).toISOString());
    if (filter.endDate) q = q.where("timestamp", "<=", new Date(filter.endDate).toISOString());
    return q;
  };

  const cntRow = await applyFilters(
    db.selectFrom("requestDetails").select((eb) => eb.fn.countAll().as("c")),
  ).executeTakeFirst();
  const totalItems = Number(cntRow?.c ?? 0);

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = await applyFilters(db.selectFrom("requestDetails").select("data"))
    .orderBy("timestamp", "desc").limit(pageSize).offset(offset).execute();
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctApiKeys() {
  const db = await getDb();
  const rows = await db.selectFrom("requestDetails").select("apiKey").distinct()
    .where("apiKey", "is not", null).orderBy("apiKey", "asc").execute();
  return rows.map((r) => r.apiKey);
}

export async function getDistinctProviders() {
  const db = await getDb();
  const rows = await db.selectFrom("requestDetails").select("provider").distinct()
    .where("provider", "is not", null).orderBy("provider", "asc").execute();
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getDb();
  const row = await db.selectFrom("requestDetails").select("data").where("id", "=", id).executeTakeFirst();
  return row ? parseJson(row.data, null) : null;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
