import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";
import { FORMATS } from "../translator/formats.js";

const EXPOSED_HEADERS = [
  "Retry-After",
  "X-9Router-Retry-At",
  "X-9Router-Reason",
  "X-9Router-Provider",
  "X-9Router-Model",
  "request-id",
  "X-Request-Id",
].join(", ");

const QUOTA_PATTERN = /rate[ _-]?limit|too many requests|quota|usage[_ -]?limit|monthly_request_count/i;
const OVERLOAD_PATTERN = /overload|capacity/i;
const TRANSPORT_PATTERN = /UND_ERR_|ECONN|EPIPE|socket|headers timeout|fetch failed|network error/i;
const SECRET_PATTERN = /(bearer\s+)[^\s,;]+|\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function statusInfo(statusCode) {
  return ERROR_TYPES[statusCode] || (statusCode >= 500
    ? { type: "api_error", code: "internal_server_error" }
    : { type: "invalid_request_error", code: "bad_request" });
}

function headerValue(value) {
  return String(value ?? "").replace(/[\r\n]/g, " ").slice(0, 512);
}

export function createRequestId() {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `req_${id.replaceAll("-", "")}`;
}

export function detectErrorFormat(pathname = "") {
  if (pathname.includes("/v1/messages")) return FORMATS.CLAUDE;
  if (pathname.includes("/v1/responses")) return FORMATS.OPENAI_RESPONSES;
  if (pathname.includes("/v1beta/models")) return FORMATS.GEMINI;
  if (pathname.includes("/v1/api/chat")) return FORMATS.OLLAMA;
  return FORMATS.OPENAI;
}

export function createErrorContext(request, options = null) {
  let pathname = "";
  try { pathname = new URL(request?.url || "http://localhost/").pathname; } catch {}
  const context = options && typeof options === "object" ? options : {};
  const errorFormat = typeof options === "string" ? options : context.errorFormat;
  return {
    requestId: context.requestId || createRequestId(),
    errorFormat: errorFormat || detectErrorFormat(pathname),
  };
}

export function sanitizePublicMessage(value, fallback = "Upstream provider request failed") {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || TRANSPORT_PATTERN.test(normalized)) return fallback;
  return normalized.replace(SECRET_PATTERN, "$1[redacted]").replace(EMAIL_PATTERN, "[redacted]").slice(0, 1000);
}

export function classifyRoutingReason(statusCode, message, retryAtMs = null) {
  if (statusCode === 429 || QUOTA_PATTERN.test(String(message || ""))) return "quota_exhausted";
  if (statusCode === 529 || OVERLOAD_PATTERN.test(String(message || ""))) return "overloaded";
  if (retryAtMs || statusCode >= 500) return "temporarily_unavailable";
  return null;
}

export function publicStatusForReason(statusCode, reason) {
  if (reason === "quota_exhausted") return 429;
  if (reason === "overloaded") return 529;
  if (reason === "no_active_credentials") return 503;
  return statusCode;
}

export function retryAfterSeconds(retryAtMs, nowMs = Date.now()) {
  return Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000) + 1);
}

export function createErrorDescriptor(statusCode, message, options = {}) {
  const routing = options.routing || {};
  const retryAtMs = Number(routing.retryAtMs ?? options.retryAtMs);
  const reason = routing.reason || options.reason || classifyRoutingReason(statusCode, message, Number.isFinite(retryAtMs) ? retryAtMs : null);
  const status = publicStatusForReason(statusCode, reason);
  const info = statusInfo(status);
  const requestId = options.requestId || createRequestId();
  const safeMessage = sanitizePublicMessage(message, DEFAULT_ERROR_MESSAGES[status] || "An error occurred");
  const nowMs = options.nowMs ?? Date.now();
  const validRetryAtMs = Number.isFinite(retryAtMs) && retryAtMs > nowMs ? retryAtMs : null;

  return {
    type: "error",
    error: { type: info.type, message: safeMessage },
    request_id: requestId,
    routing: {
      reason: reason || undefined,
      provider: routing.provider || options.provider || undefined,
      model: routing.model || options.model || undefined,
      retryable: routing.retryable ?? options.retryable ?? (validRetryAtMs !== null || status === 429 || status >= 500),
      retryAfter: validRetryAtMs !== null ? retryAfterSeconds(validRetryAtMs, nowMs) : undefined,
      retryAt: validRetryAtMs !== null ? new Date(validRetryAtMs).toISOString() : undefined,
    },
    status,
    code: info.code,
  };
}

export function serializeErrorDescriptor(descriptor, format = FORMATS.OPENAI) {
  if (format === FORMATS.CLAUDE) {
    return {
      type: "error",
      error: { ...descriptor.error },
      request_id: descriptor.request_id,
    };
  }

  if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
    const status = descriptor.routing.reason === "quota_exhausted"
      ? "RESOURCE_EXHAUSTED"
      : descriptor.status === 504
        ? "DEADLINE_EXCEEDED"
        : descriptor.status >= 500
          ? "UNAVAILABLE"
          : "INVALID_ARGUMENT";
    return { error: { code: descriptor.status, message: descriptor.error.message, status } };
  }

  if (format === FORMATS.OLLAMA) return { error: descriptor.error.message };

  return {
    error: {
      message: descriptor.error.message,
      type: descriptor.error.type,
      param: null,
      code: descriptor.code,
    },
  };
}

function responseHeaders(descriptor, format) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": EXPOSED_HEADERS,
  });
  headers.set(format === FORMATS.CLAUDE ? "request-id" : "X-Request-Id", descriptor.request_id);
  const routing = descriptor.routing;
  if (routing.retryAfter !== undefined) headers.set("Retry-After", String(routing.retryAfter));
  if (routing.retryAt) headers.set("X-9Router-Retry-At", routing.retryAt);
  if (routing.reason) headers.set("X-9Router-Reason", headerValue(routing.reason));
  if (routing.provider) headers.set("X-9Router-Provider", headerValue(routing.provider));
  if (routing.model) headers.set("X-9Router-Model", headerValue(routing.model));
  return headers;
}

export function responseFromErrorDescriptor(descriptor, format = FORMATS.OPENAI) {
  return new Response(JSON.stringify(serializeErrorDescriptor(descriptor, format)), {
    status: descriptor.status,
    headers: responseHeaders(descriptor, format),
  });
}

export function responseFromRoutingCandidate(candidate, options = {}) {
  const descriptor = createErrorDescriptor(candidate.status, candidate.message, {
    ...options,
    routing: {
      reason: candidate.reason,
      provider: candidate.provider,
      model: candidate.model,
      retryable: candidate.retryable,
      retryAtMs: candidate.retryAtMs,
    },
  });
  return responseFromErrorDescriptor(descriptor, options.errorFormat || FORMATS.OPENAI);
}

export function withRequestId(response, context) {
  if (!(response instanceof Response) || !context?.requestId) return response;
  const headers = new Headers(response.headers);
  headers.set(context.errorFormat === FORMATS.CLAUDE ? "request-id" : "X-Request-Id", context.requestId);
  headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Error payload for a stream that already answered HTTP 200 and failed mid-flight,
 * shaped for the client format so formatSSE frames it as that format's error event.
 * Defaults to 502 because a mid-stream failure carries no status of its own.
 */
export function errorStreamChunk(format, message, statusCode = 502) {
  const body = serializeErrorDescriptor(createErrorDescriptor(statusCode, message), format);
  if (format === FORMATS.CLAUDE) return { type: "error", error: body.error };
  if (format === FORMATS.OPENAI_RESPONSES) return { event: "error", data: { type: "error", error: body.error } };
  return body;
}

export function errorResponse(statusCode, message, options = {}) {
  const descriptor = options.descriptor || createErrorDescriptor(statusCode, message, options);
  return responseFromErrorDescriptor(descriptor, options.errorFormat || FORMATS.OPENAI);
}

export function resetsAtFromHeaders(response) {
  try {
    const h = response?.headers;
    if (typeof h?.get !== "function") return undefined;
    const now = Date.now();
    const unified = h.get("anthropic-ratelimit-unified-reset");
    if (unified) {
      const n = Number(unified);
      const ms = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(unified);
      if (Number.isFinite(ms) && ms > now) return ms;
    }
    const retryAfter = h.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs > 0) return now + secs * 1000;
      const ms = Date.parse(retryAfter);
      if (Number.isFinite(ms) && ms > now) return ms;
    }
  } catch {}
  return undefined;
}

export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try { bodyText = await response.text(); } catch {}
  const headerResetsAtMs = resetsAtFromHeaders(response);

  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        return {
          statusCode: parsed.status || response.status,
          message: sanitizePublicMessage(parsed.message, DEFAULT_ERROR_MESSAGES[response.status]),
          resetsAtMs: parsed.resetsAtMs ?? headerResetsAtMs,
        };
      }
    } catch {}
  }

  let message;
  try {
    const json = JSON.parse(bodyText);
    message = json?.error?.message ?? json?.message;
  } catch {}

  return {
    statusCode: response.status,
    message: sanitizePublicMessage(message, DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`),
    resetsAtMs: headerResetsAtMs,
  };
}

export function createErrorResult(statusCode, message, resetsAtMs, options = {}) {
  const descriptor = createErrorDescriptor(statusCode, message, { ...options, retryAtMs: resetsAtMs });
  return {
    success: false,
    status: statusCode,
    error: descriptor.error.message,
    resetsAtMs,
    descriptor,
    response: responseFromErrorDescriptor(descriptor, options.errorFormat || FORMATS.OPENAI),
  };
}

export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, options = {}) {
  const retryAtMs = retryAfter instanceof Date ? retryAfter.getTime() : new Date(retryAfter).getTime();
  const descriptor = createErrorDescriptor(statusCode, message, {
    ...options,
    retryAtMs,
    routing: { ...(options.routing || {}), retryAtMs },
  });
  return responseFromErrorDescriptor(descriptor, options.errorFormat || FORMATS.OPENAI);
}

export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error?.code || "FETCH_FAILED";
  const message = sanitizePublicMessage(error?.message);
  return `[${code}]: ${message}`;
}
