import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, handleComboChat, handleFusionChat, resetComboRotation } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});


const log = { info() {}, warn() {} };
const retryResponse = (retryAt, marker, status = 429) => new Response(
  JSON.stringify({ error: { message: marker } }),
  {
    status,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": "60",
      "X-9Router-Retry-At": retryAt,
      "X-9Router-Reason": "quota_exhausted",
      "X-Marker": marker,
    },
  }
);
const noCredentialsResponse = () => new Response(
  JSON.stringify({ error: { message: "No active credentials" } }),
  { status: 503, headers: { "X-9Router-Reason": "no_active_credentials" } }
);

describe("combo unavailable candidate selection", () => {
  it("returns the complete response with the earliest retry and skips missing credentials", async () => {
    const calls = [];
    const responses = {
      "provider/missing": noCredentialsResponse(),
      "provider/later": retryResponse("2099-01-01T00:02:00.000Z", "later"),
      "provider/earlier": retryResponse("2099-01-01T00:01:00.000Z", "earlier", 529),
    };

    const result = await handleComboChat({
      body: {},
      models: Object.keys(responses),
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return responses[model];
      },
      log,
      comboName: "test",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(Object.keys(responses));
    expect(result).toBe(responses["provider/earlier"]);
    expect(result.status).toBe(529);
    expect(result.headers.get("X-Marker")).toBe("earlier");
    await expect(result.json()).resolves.toEqual({ error: { message: "earlier" } });
  });

  it("preserves original order when retry timestamps tie", async () => {
    const first = retryResponse("2099-01-01T00:01:00.000Z", "first");
    const second = retryResponse("2099-01-01T00:01:00.000Z", "second");
    const result = await handleComboChat({
      body: {}, models: ["p/a", "p/b"], log,
      handleSingleModel: async (_body, model) => model === "p/a" ? first : second,
    });
    expect(result).toBe(first);
  });

  it("returns a 503 configuration error without Retry-After when all credentials are missing", async () => {
    const result = await handleComboChat({
      body: {}, models: ["p/a", "p/b"], log, comboName: "test",
      handleSingleModel: async () => noCredentialsResponse(),
    });
    expect(result.status).toBe(503);
    expect(result.headers.get("Retry-After")).toBeNull();
    expect(result.headers.get("X-9Router-Reason")).toBe("no_active_credentials");
  });

  it("returns the earliest failed panel response when fusion has no successful answer", async () => {
    const later = retryResponse("2099-01-01T00:02:00.000Z", "later");
    const earlier = retryResponse("2099-01-01T00:01:00.000Z", "earlier");
    const result = await handleFusionChat({
      body: {}, models: ["p/later", "p/missing", "p/earlier"], log, comboName: "fusion",
      tuning: { minPanel: 2, stragglerGraceMs: 1, panelHardTimeoutMs: 100 },
      handleSingleModel: async (_body, model) => model.endsWith("missing") ? noCredentialsResponse() : model.endsWith("later") ? later : earlier,
    });
    expect(result).toBe(earlier);
  });
});
