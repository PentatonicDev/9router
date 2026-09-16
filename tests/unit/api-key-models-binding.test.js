import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: mocks.getApiKeyAllowedConnectionIds,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));

const { buildModelsList } = await import("@/app/api/v1/models/route.js");

const conn = (id, provider) => ({
  id,
  provider,
  authType: "oauth",
  isActive: true,
  priority: 1,
  providerSpecificData: { enabledModels: [`${provider}-model-1`] },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getProviderConnections.mockResolvedValue([conn("a", "claude"), conn("b", "openai")]);
});

const providersOf = (models) => [...new Set(models.map((m) => m.owned_by))].sort();

describe("/v1/models — account binding", () => {
  it("lists only the providers of the key's accounts", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["b"]);

    const models = await buildModelsList(["llm"], { apiKey: "sk-bound", skipDynamicFetch: true });

    expect(providersOf(models)).toEqual(["openai"]);
  });

  it("lists every provider for an unbound key", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);

    const models = await buildModelsList(["llm"], { apiKey: "sk-free", skipDynamicFetch: true });

    expect(providersOf(models)).toEqual(["cc", "openai"]);
  });

  // The static-catalog fallback exists for an unreachable DB. A key whose
  // accounts all vanished must get an empty list, never the full catalog.
  it("returns nothing when the key's accounts no longer exist", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["gone"]);

    const models = await buildModelsList(["llm"], { apiKey: "sk-orphan", skipDynamicFetch: true });

    expect(models).toEqual([]);
  });

  it("still falls back to the static catalog when the DB is unreachable", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("db down"));
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);

    const models = await buildModelsList(["llm"], { apiKey: null, skipDynamicFetch: true });

    expect(models.length).toBeGreaterThan(0);
  });
});
