// Combo per-model thinking cap (modelOptions.maxThinking): clamp logic, plumbing
// through translateRequest/chatCore, the combos API contract, and the combosRepo
// round-trip. See open-sse/translator/concerns/thinkingUnified.js (clampToMax)
// and src/sse/handlers/chat.js (per-candidate comboModelOptions threading).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// --- Mocks (must live at module top level — vi.mock/vi.hoisted are hoisted
// above all imports regardless of where they're written, and a module can
// only have one mock factory per file) -------------------------------------

const mocks = vi.hoisted(() => ({
  // @/lib/localDb — shared by the combos API tests and the chat.js test.
  getCombos: vi.fn(),
  createCombo: vi.fn(),
  getComboByName: vi.fn(),
  getComboById: vi.fn(),
  updateCombo: vi.fn(),
  deleteCombo: vi.fn(),
  getSettings: vi.fn(),
  getApiKeyRoutingContext: vi.fn(),
  getModelAliases: vi.fn(),
  getProviderNodes: vi.fn(),
  // combos API only
  getHiddenComboNames: vi.fn(async () => []),
  getRequestIdentity: vi.fn(async () => ({ isAdmin: true, owner: "@admin" })),
  getScopeFilter: vi.fn(async () => null),
  ownerForCreate: vi.fn(async (o) => o ?? null),
  // open-sse/services/combo.js — resetComboRotation (API) + fallback strategy (chat.js)
  resetComboRotation: vi.fn(),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(),
  // chat.js routing test only
  getProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  augmentModelsWithCapacityAdapter: vi.fn(),
  withCapacityAdapterStripping: vi.fn(),
  getActiveAdapterStrategy: vi.fn(),
  handleBypassRequest: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "Content-Type": "application/json" },
    }),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getCombos: mocks.getCombos,
  createCombo: mocks.createCombo,
  getComboByName: mocks.getComboByName,
  getComboById: mocks.getComboById,
  updateCombo: mocks.updateCombo,
  deleteCombo: mocks.deleteCombo,
  getSettings: mocks.getSettings,
  getApiKeyRoutingContext: mocks.getApiKeyRoutingContext,
  getModelAliases: mocks.getModelAliases,
  getProviderNodes: mocks.getProviderNodes,
}));
vi.mock("@/lib/db/repos/hiddenCombosRepo.js", () => ({ getHiddenComboNames: mocks.getHiddenComboNames }));
vi.mock("@/lib/auth/resourceScope", () => ({
  getRequestIdentity: mocks.getRequestIdentity,
  getScopeFilter: mocks.getScopeFilter,
  ownerForCreate: mocks.ownerForCreate,
  scopeVisible: (rows) => rows,
  canSee: () => true,
  normalizeOwnerInput: (o) => o,
  // combosRepo.js (real, exercised by the SQLite round-trip describe below)
  // and scopedSettings.js (real, exercised by the chat.js describe below)
  // both import these directly.
  resolveDefaultOwner: vi.fn(async () => null),
  isScopeEnabled: vi.fn(() => false),
}));
vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleFusionChat,
  detectRequiredCapabilities: mocks.detectRequiredCapabilities,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: mocks.augmentModelsWithCapacityAdapter,
  withCapacityAdapterStripping: mocks.withCapacityAdapterStripping,
  getActiveAdapterStrategy: mocks.getActiveAdapterStrategy,
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.handleBypassRequest }));

describe("clampToMax via applyThinking — openai target", () => {
  it("budget 32000 (→ xhigh via budgetToLevel) capped to high", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 32000 } };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai", undefined, null, "high");
    expect(out.reasoning_effort).toBe("high");
  });

  it("client requests below the cap → stays as requested", () => {
    const body = { reasoning_effort: "low" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai", undefined, null, "high");
    expect(out.reasoning_effort).toBe("low");
  });

  it("requested level exactly equal to the cap is left alone (equality boundary — mutation-proof for a <=→< guard mutation)", () => {
    const body = { reasoning_effort: "high" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai", undefined, null, "high");
    expect(out.reasoning_effort).toBe("high");
  });

  it("no cap (maxLevel omitted) → unchanged", () => {
    const body = { reasoning_effort: "xhigh" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("mode auto is never clamped, even under a low cap", () => {
    const body = { reasoning_effort: "auto" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai", undefined, null, "low");
    expect(out.reasoning_effort).toBe("auto");
  });

  it("mode none is never clamped", () => {
    const body = { reasoning_effort: "none" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai", undefined, null, "low");
    expect(out.reasoning_effort).toBe("none");
  });

  it("a cap value absent from THINKING_ORDER is ignored (curIdx/maxIdx -1 guard)", () => {
    const body = { reasoning_effort: "high" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai", undefined, null, "not-a-real-level");
    expect(out.reasoning_effort).toBe("high");
  });
});

describe("translateRequest: maxThinkingLevel reaches Kiro's direct translator", () => {
  it("caps Claude adaptive effort before Kiro builds its native request", () => {
    const body = {
      model: "kr/claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-5", body,
      false, {}, "kiro", null, [], null, null, "low");
    expect(out.additionalModelRequestFields?.output_config?.effort).toBe("low");
  });

  it("caps a thinking suffix without requiring explicit client effort", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-5-thinking", body,
      false, {}, "kiro", null, [], null, null, "low");
    expect(out.additionalModelRequestFields?.output_config?.effort).toBe("low");
  });

  it("caps an explicit model(high) override after it replaces the body effort", () => {
    const body = { messages: [{ role: "user", content: "hi" }], output_config: { effort: "low" } };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-5(high)", body,
      false, {}, "kiro", null, [], null, null, "low");
    expect(out.additionalModelRequestFields?.output_config?.effort).toBe("low");
  });

  it("caps OpenAI-format Kiro requests through their translator too", () => {
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" };
    const out = translateRequest(FORMATS.OPENAI, FORMATS.KIRO, "claude-sonnet-5", body,
      false, {}, "kiro", null, [], null, null, "low");
    expect(out.additionalModelRequestFields?.output_config?.effort).toBe("low");
  });

  it("does not enable thinking on a plain model without client intent", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-haiku-4.5", body,
      false, {}, "kiro", null, [], null, null, "low");
    expect(out.additionalModelRequestFields).toBeUndefined();
  });
});

describe("translateRequest: maxThinkingLevel threads through to the Codex target", () => {
  it("Claude budget_tokens 32000 → Codex body.reasoning_effort capped to high (not xhigh)", () => {
    const body = {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 32000 },
    };
    const out = translateRequest(
      FORMATS.CLAUDE, FORMATS.CODEX, "gpt-5.6-sol", body,
      false, null, "codex", null, [], null, null, "high"
    );
    expect(out.reasoning_effort).toBe("high");
  });
});

describe("Codex native-passthrough applyThinking call site: cap fires there too", () => {
  it("a suffix override above the cap is clamped (second call site in chatCore.js)", () => {
    const suffixThinking = {};
    applyThinking(FORMATS.OPENAI_RESPONSES, "gpt-5.6-sol(xhigh)", suffixThinking, "codex", undefined, null, "high");
    expect(suffixThinking.reasoning_effort).toBe("high");
  });
});

describe("combosRepo: modelOptions round-trip (real SQLite, temp DATA_DIR)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-cap-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("createCombo without modelOptions → modelOptions is null (backward compat)", async () => {
    const combo = await db.createCombo({ name: "no-cap-combo", models: ["openai/gpt-5"] });
    expect(combo.modelOptions).toBeNull();
    const fetched = await db.getComboById(combo.id);
    expect(fetched.modelOptions).toBeNull();
  });

  it("updateCombo adding modelOptions round-trips it", async () => {
    const combo = await db.createCombo({ name: "capped-combo", models: ["openai/gpt-5"] });
    const modelOptions = { "openai/gpt-5": { maxThinking: "high" } };
    const updated = await db.updateCombo(combo.id, { modelOptions });
    expect(updated.modelOptions).toEqual(modelOptions);
    const fetched = await db.getComboById(combo.id);
    expect(fetched.modelOptions).toEqual(modelOptions);
  });
});

describe("combos API: modelOptions round-trip + unknown-level rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getComboByName.mockResolvedValue(null);
    mocks.getHiddenComboNames.mockResolvedValue([]);
    mocks.getRequestIdentity.mockResolvedValue({ isAdmin: true, owner: "@admin" });
    mocks.getScopeFilter.mockResolvedValue(null);
    mocks.ownerForCreate.mockImplementation(async (o) => o ?? null);
  });

  it("POST rejects an unknown maxThinking level", async () => {
    const { POST } = await import("@/app/api/combos/route.js");
    const req = new Request("http://localhost/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "combo1", models: ["openai/gpt-5"],
        modelOptions: { "openai/gpt-5": { maxThinking: "nope" } },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mocks.createCombo).not.toHaveBeenCalled();
  });

  it("POST round-trips a valid modelOptions map", async () => {
    mocks.createCombo.mockImplementation(async (data) => ({ id: "c1", ...data }));
    const { POST } = await import("@/app/api/combos/route.js");
    const modelOptions = { "openai/gpt-5": { maxThinking: "high" } };
    const req = new Request("http://localhost/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "combo1", models: ["openai/gpt-5"], modelOptions }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.modelOptions).toEqual(modelOptions);
    expect(mocks.createCombo).toHaveBeenCalledWith(expect.objectContaining({ modelOptions }));
  });

  it("PUT rejects an unknown maxThinking level without touching updateCombo", async () => {
    mocks.getComboById.mockResolvedValue({ id: "c1", name: "combo1", owner: null, models: ["openai/gpt-5"] });
    const { PUT } = await import("@/app/api/combos/[id]/route.js");
    const req = new Request("http://localhost/api/combos/c1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelOptions: { "openai/gpt-5": { maxThinking: "bogus" } } }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(400);
    expect(mocks.updateCombo).not.toHaveBeenCalled();
  });

  it("PUT round-trips a valid modelOptions map", async () => {
    mocks.getComboById.mockResolvedValue({ id: "c1", name: "combo1", owner: null, models: ["openai/gpt-5"] });
    const modelOptions = { "openai/gpt-5": { maxThinking: "low" } };
    mocks.updateCombo.mockImplementation(async (id, patch) => ({
      id, name: "combo1", owner: null, models: ["openai/gpt-5"], ...patch,
    }));
    const { PUT } = await import("@/app/api/combos/[id]/route.js");
    const req = new Request("http://localhost/api/combos/c1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelOptions }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.modelOptions).toEqual(modelOptions);
  });
});

describe("chat.js: comboModelOptions resolution (F3 — nested combo never inherits the outer combo's cap map)", () => {
  // Two candidates share the literal model string "openai/gpt-5", one at the
  // outer combo's own level (cap "high") and one inside a combo nested as a
  // fallback candidate (cap "low") — the exact shape F3 flags as a leak risk
  // if the cap map were stored on the shared, mutated routingContext object.
  const COMBOS = {
    "outer-combo": {
      id: "outer", name: "outer-combo", owner: null,
      models: ["nested-combo", "openai/gpt-5"],
      modelOptions: { "openai/gpt-5": { maxThinking: "high" } },
    },
    "nested-combo": {
      id: "nested", name: "nested-combo", owner: null,
      models: ["openai/gpt-5"],
      modelOptions: { "openai/gpt-5": { maxThinking: "low" } },
    },
    "combo-wide-cap": {
      id: "wide", name: "combo-wide-cap", owner: null,
      models: ["openai/gpt-5", "anthropic/claude"],
      modelOptions: null,
      maxThinking: "high",
    },
    "combo-per-model-lower": {
      id: "lower", name: "combo-per-model-lower", owner: null,
      models: ["openai/gpt-5"],
      modelOptions: { "openai/gpt-5": { maxThinking: "low" } },
      maxThinking: "high",
    },
    "combo-per-model-higher": {
      id: "higher", name: "combo-per-model-higher", owner: null,
      models: ["openai/gpt-5"],
      modelOptions: { "openai/gpt-5": { maxThinking: "xhigh" } },
      maxThinking: "high",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getApiKeyRoutingContext.mockResolvedValue({ valid: true, owner: null });
    mocks.getComboByName.mockImplementation(async (name) => COMBOS[name] || null);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.handleBypassRequest.mockReturnValue(null);
    mocks.detectRequiredCapabilities.mockReturnValue(new Set());
    // Identity passthroughs: no capacity-adapter augmentation in this test.
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
    mocks.withCapacityAdapterStripping.mockImplementation((fn) => fn);
    mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "conn-1", providerSpecificData: {} });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });
    // Fallback strategy stub: try every candidate model in order (the real
    // combo.js sequential-fallback shape, minus the retry/short-circuit logic
    // this test doesn't need — only the cap-map plumbing is under test).
    const tryAll = async ({ body, models, handleSingleModel }) => {
      let result;
      for (const m of models) result = await handleSingleModel(body, m);
      return result;
    };
    mocks.handleComboChat.mockImplementation(tryAll);
    mocks.handleFusionChat.mockImplementation(tryAll);
  });

  it("outer combo's second candidate keeps its own cap after a nested-combo candidate resolved first", async () => {
    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "outer-combo", messages: [{ role: "user", content: "hi" }] }),
    });
    await handleChat(req);

    const maxLevels = mocks.handleChatCore.mock.calls.map((call) => call[0].maxThinkingLevel);
    // Candidate 1: nested-combo's own leaf "openai/gpt-5" → nested's cap "low".
    // Candidate 2: outer-combo's own leaf "openai/gpt-5" (same model string) →
    // must read "high" (outer's own map), never "low" leaked from the nested
    // resolution that ran first in the same fallback loop.
    expect(maxLevels).toEqual(["low", "high"]);
  });

  it("combo-wide cap alone clamps every model in the combo to the same level", async () => {
    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "combo-wide-cap", messages: [{ role: "user", content: "hi" }] }),
    });
    await handleChat(req);

    const maxLevels = mocks.handleChatCore.mock.calls.map((call) => call[0].maxThinkingLevel);
    expect(maxLevels).toEqual(["high", "high"]);
  });

  it("per-model cap lower than the combo-wide cap wins", async () => {
    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "combo-per-model-lower", messages: [{ role: "user", content: "hi" }] }),
    });
    await handleChat(req);

    const maxLevels = mocks.handleChatCore.mock.calls.map((call) => call[0].maxThinkingLevel);
    expect(maxLevels).toEqual(["low"]);
  });

  it("per-model cap higher than the combo-wide cap loses — combo cap wins", async () => {
    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "combo-per-model-higher", messages: [{ role: "user", content: "hi" }] }),
    });
    await handleChat(req);

    const maxLevels = mocks.handleChatCore.mock.calls.map((call) => call[0].maxThinkingLevel);
    expect(maxLevels).toEqual(["high"]);
  });
});

describe("resolveMaxThinkingLevel (mutation-proof min-of-two-caps logic)", () => {
  it("combo cap alone (no per-model cap) → combo cap wins", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel("high", null)).toBe("high");
  });

  it("per-model cap alone (no combo cap) → per-model cap wins", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel(null, "low")).toBe("low");
  });

  it("per-model cap lower than combo cap → per-model wins", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel("high", "low")).toBe("low");
  });

  it("per-model cap higher than combo cap → combo cap wins", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel("low", "high")).toBe("low");
  });

  it("equal caps → that level is returned", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel("medium", "medium")).toBe("medium");
  });

  it("both absent → null", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel(null, null)).toBeNull();
  });

  it("combo cap unknown level is ignored — per-model cap applies", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel("bogus", "low")).toBe("low");
  });

  it("per-model cap unknown level is ignored — combo cap applies", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    expect(resolveMaxThinkingLevel("high", "bogus")).toBe("high");
  });
});

describe("combos API: maxThinking (combo-wide cap) validation + round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getComboByName.mockResolvedValue(null);
    mocks.getHiddenComboNames.mockResolvedValue([]);
    mocks.getRequestIdentity.mockResolvedValue({ isAdmin: true, owner: "@admin" });
    mocks.getScopeFilter.mockResolvedValue(null);
    mocks.ownerForCreate.mockImplementation(async (o) => o ?? null);
  });

  it("POST rejects an unknown maxThinking level", async () => {
    const { POST } = await import("@/app/api/combos/route.js");
    const req = new Request("http://localhost/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "combo1", models: ["openai/gpt-5"], maxThinking: "nope" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mocks.createCombo).not.toHaveBeenCalled();
  });

  it("POST round-trips a valid combo-wide maxThinking", async () => {
    mocks.createCombo.mockImplementation(async (data) => ({ id: "c1", ...data }));
    const { POST } = await import("@/app/api/combos/route.js");
    const req = new Request("http://localhost/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "combo1", models: ["openai/gpt-5"], maxThinking: "high" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.maxThinking).toBe("high");
    expect(mocks.createCombo).toHaveBeenCalledWith(expect.objectContaining({ maxThinking: "high" }));
  });

  it("PUT rejects an unknown maxThinking level without touching updateCombo", async () => {
    mocks.getComboById.mockResolvedValue({ id: "c1", name: "combo1", owner: null, models: ["openai/gpt-5"] });
    const { PUT } = await import("@/app/api/combos/[id]/route.js");
    const req = new Request("http://localhost/api/combos/c1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxThinking: "bogus" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(400);
    expect(mocks.updateCombo).not.toHaveBeenCalled();
  });

  it("PUT round-trips a valid combo-wide maxThinking", async () => {
    mocks.getComboById.mockResolvedValue({ id: "c1", name: "combo1", owner: null, models: ["openai/gpt-5"] });
    mocks.updateCombo.mockImplementation(async (id, patch) => ({
      id, name: "combo1", owner: null, models: ["openai/gpt-5"], ...patch,
    }));
    const { PUT } = await import("@/app/api/combos/[id]/route.js");
    const req = new Request("http://localhost/api/combos/c1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxThinking: "low" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.maxThinking).toBe("low");
  });
});

describe("combosRepo: maxThinking (combo-wide cap) round-trip (real SQLite, temp DATA_DIR)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-wide-cap-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("createCombo without maxThinking → maxThinking is null (backward compat)", async () => {
    const combo = await db.createCombo({ name: "no-wide-cap-combo", models: ["openai/gpt-5"] });
    expect(combo.maxThinking).toBeNull();
    const fetched = await db.getComboById(combo.id);
    expect(fetched.maxThinking).toBeNull();
  });

  it("updateCombo adding maxThinking round-trips it", async () => {
    const combo = await db.createCombo({ name: "wide-capped-combo", models: ["openai/gpt-5"] });
    const updated = await db.updateCombo(combo.id, { maxThinking: "high" });
    expect(updated.maxThinking).toBe("high");
    const fetched = await db.getComboById(combo.id);
    expect(fetched.maxThinking).toBe("high");
  });
});

describe("per-turn effort from the decision's deliberation", () => {
  it("caps a mechanical turn low and leaves a hard one alone", async () => {
    const { effortCeilingForDeliberation } = await import("../../src/sse/handlers/chat.js");
    // Only the bottom of the range is capped: a hard turn keeps whatever the client
    // asked for, because a ceiling can only lower a budget, never raise it.
    expect(effortCeilingForDeliberation(0.05)).toBe("low");
    expect(effortCeilingForDeliberation(0.29)).toBe("low");
    expect(effortCeilingForDeliberation(0.45)).toBe("medium");
    expect(effortCeilingForDeliberation(0.69)).toBe("medium");
    expect(effortCeilingForDeliberation(0.7)).toBeNull();
    expect(effortCeilingForDeliberation(0.95)).toBeNull();
    // No verdict (solo request, decision off, or a failed call) must change nothing.
    expect(effortCeilingForDeliberation(null)).toBeNull();
    expect(effortCeilingForDeliberation(undefined)).toBeNull();
    expect(effortCeilingForDeliberation("0.1")).toBeNull();
  });

  it("the tightest cap wins when the per-turn one joins the two existing caps", async () => {
    const { resolveMaxThinkingLevel } = await import("../../src/sse/handlers/chat.js");
    // Two-arg behaviour is unchanged.
    expect(resolveMaxThinkingLevel("high", "low")).toBe("low");
    expect(resolveMaxThinkingLevel(null, null)).toBeNull();
    // Three: the per-turn cap is a ceiling like the others, so a lower static cap
    // still wins over a higher per-turn one.
    expect(resolveMaxThinkingLevel("high", null, "low")).toBe("low");
    expect(resolveMaxThinkingLevel("high", "medium", "low")).toBe("low");
    expect(resolveMaxThinkingLevel("minimal", "high", "low")).toBe("minimal");
    // And a null per-turn cap (hard turn) never loosens the static ones.
    expect(resolveMaxThinkingLevel("medium", null, null)).toBe("medium");
  });
});
