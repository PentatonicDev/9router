import { describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  createErrorDescriptor,
  errorResponse,
  parseUpstreamError,
  retryAfterSeconds,
  serializeErrorDescriptor,
} from "../../open-sse/utils/error.js";
import {
  buildClearModelLocksUpdate,
  buildModelLockUpdate,
  getApplicableModelLock,
} from "../../open-sse/services/accountFallback.js";

describe("canonical error contract", () => {
  it("maps official Anthropic error types", () => {
    expect(createErrorDescriptor(404, "missing").error.type).toBe("not_found_error");
    expect(createErrorDescriptor(413, "large").error.type).toBe("request_too_large");
    expect(createErrorDescriptor(529, "busy").error.type).toBe("overloaded_error");
    expect(createErrorDescriptor(504, "timeout").error.type).toBe("api_error");
  });

  it("serializes exact Anthropic envelope and matching request id", async () => {
    const response = errorResponse(429, "Quota exhausted", {
      errorFormat: FORMATS.CLAUDE,
      requestId: "req_test",
      retryAtMs: Date.parse("2026-09-13T00:00:10.000Z"),
      nowMs: Date.parse("2026-09-13T00:00:00.000Z"),
      reason: "quota_exhausted",
      provider: "claude",
      model: "opus",
    });
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "Quota exhausted" },
      request_id: "req_test",
    });
    expect(response.headers.get("request-id")).toBe("req_test");
    expect(response.headers.get("Retry-After")).toBe("11");
    expect(response.headers.get("X-9Router-Retry-At")).toBe("2026-09-13T00:00:10.000Z");
    expect(response.headers.get("X-9Router-Provider")).toBe("claude");
  });

  it("translates to Gemini and Ollama envelopes", () => {
    const descriptor = createErrorDescriptor(429, "Quota exhausted", { reason: "quota_exhausted" });
    expect(serializeErrorDescriptor(descriptor, FORMATS.GEMINI)).toEqual({
      error: { code: 429, message: "Quota exhausted", status: "RESOURCE_EXHAUSTED" },
    });
    expect(serializeErrorDescriptor(descriptor, FORMATS.OLLAMA)).toEqual({ error: "Quota exhausted" });
  });

  it("adds one second after rounding up", () => {
    expect(retryAfterSeconds(10_001, 0)).toBe(12);
    expect(retryAfterSeconds(10_000, 0)).toBe(11);
    expect(retryAfterSeconds(-1, 0)).toBe(1);
  });

  it("sanitizes transport causes and arbitrary upstream bodies", async () => {
    const parsed = await parseUpstreamError(new Response("<html>token sk-secretsecret a@example.com UND_ERR_SOCKET</html>", { status: 502 }));
    expect(parsed.message).toBe("Bad gateway - upstream provider error");
    expect(parsed.message).not.toMatch(/secret|example|UND_ERR/);
  });
});

describe("applicable model lock", () => {
  it("uses max of model and global locks and preserves matching metadata", () => {
    const connection = {
      modelLock_m: "2026-09-13T00:00:10.000Z",
      modelLockMeta_m: { message: "model" },
      modelLock___all: "2026-09-13T00:00:20.000Z",
      modelLockMeta___all: { message: "global" },
      modelLock_other: "2026-09-13T00:00:30.000Z",
    };
    expect(getApplicableModelLock(connection, "m", Date.parse("2026-09-13T00:00:00Z"))).toMatchObject({
      retryAtMs: Date.parse("2026-09-13T00:00:20Z"),
      meta: { message: "global" },
    });
  });

  it("classifies a metadata-less lock from the connection error state", () => {
    const connection = {
      modelLock_m: "2026-09-13T00:00:20.000Z",
      errorCode: 429,
      lastError: "This request would exceed your account's rate limit",
    };
    expect(getApplicableModelLock(connection, "m", Date.parse("2026-09-13T00:00:00Z"))).toMatchObject({
      retryAtMs: Date.parse("2026-09-13T00:00:20Z"),
      meta: { status: 429, reason: "quota_exhausted" },
    });
  });

  it("leaves a metadata-less lock unclassified when another lock could own the error state", () => {
    const connection = {
      modelLock_m: "2026-09-13T00:00:20.000Z",
      modelLock_other: "2026-09-13T00:00:30.000Z",
      errorCode: 429,
      lastError: "This request would exceed your account's rate limit",
    };
    expect(getApplicableModelLock(connection, "m", Date.parse("2026-09-13T00:00:00Z")).meta).toBeNull();
  });

  it("ignores expired, invalid, and other-model locks", () => {
    const connection = { modelLock_m: "bad", modelLock_other: "2026-09-13T00:00:30.000Z" };
    expect(getApplicableModelLock(connection, "m", Date.parse("2026-09-13T00:00:00Z"))).toBeNull();
  });

  it("writes and clears lock metadata with lock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
    try {
      expect(buildModelLockUpdate("m", 10_000, { status: 429 })).toEqual({
        modelLock_m: "2026-09-13T00:00:10.000Z",
        modelLockMeta_m: { status: 429 },
      });
      expect(buildClearModelLocksUpdate({ modelLock_m: "x", modelLockMeta_m: {} })).toEqual({
        modelLock_m: null,
        modelLockMeta_m: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
