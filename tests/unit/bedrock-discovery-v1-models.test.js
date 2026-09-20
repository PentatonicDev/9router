// /v1/models — a Bedrock connection with a persisted discoveredModels result
// surfaces those ids (br/-prefixed like every other provider); without one it
// falls back to the registry's seeded static models.
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

const bedrockConnection = (providerSpecificData) => ({
  id: "bedrock-1",
  provider: "bedrock",
  authType: "apikey",
  isActive: true,
  priority: 1,
  providerSpecificData,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
});

describe("/v1/models — bedrock discovered catalog", () => {
  it("surfaces discovered model ids, br/-prefixed, for a connection with a persisted discovery result", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      bedrockConnection({
        authMethod: "api_key",
        region: "us-east-1",
        discoveredModels: {
          at: "2026-01-01T00:00:00.000Z",
          items: [
            { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5", kind: "model", access: "granted" },
            { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "US Claude Sonnet 4.5", kind: "profile", access: "granted" },
          ],
        },
      }),
    ]);

    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const ids = models.map((m) => m.id);

    expect(ids).toContain("br/anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(ids).toContain("br/us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  it("falls back to the registry's seeded models when nothing has been discovered yet", async () => {
    mocks.getProviderConnections.mockResolvedValue([bedrockConnection({ authMethod: "api_key", region: "us-east-1" })]);

    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const ids = models.map((m) => m.id);

    // Registry seed (open-sse/providers/registry/bedrock.js) includes this id.
    expect(ids).toContain("br/anthropic.claude-opus-4-1-20250805-v1:0");
    expect(ids).not.toContain("br/us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });
});
