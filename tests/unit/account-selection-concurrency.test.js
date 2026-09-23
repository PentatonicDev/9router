// Account selection needs serialization only inside one provider pool. A global
// mutex made unrelated providers wait behind each other; per-provider locks keep
// round-robin updates safe while independent pools proceed concurrently.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProxyPools: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(),
  getApiKeyOwner: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  ...mocks,
  validateApiKey: vi.fn(),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

function connection(provider, id) {
  return {
    id,
    provider,
    authType: "api-key",
    isActive: true,
    priority: 1,
    apiKey: `token-${id}`,
    providerSpecificData: {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
  mocks.getApiKeyOwner.mockResolvedValue(null);
  mocks.updateProviderConnection.mockResolvedValue(null);
});

describe("credential-selection concurrency", () => {
  it("does not block provider B behind provider A", async () => {
    const gateA = deferred();
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => {
      if (provider === "provider-a") await gateA.promise;
      return [connection(provider, `${provider}-1`)];
    });

    const a = getProviderCredentials("provider-a", null, "model-a", {
      settings: { fallbackStrategy: "round-robin" },
      allowedConnectionIds: null,
      keyOwner: null,
    });
    const b = getProviderCredentials("provider-b", null, "model-b", {
      settings: { fallbackStrategy: "round-robin" },
      allowedConnectionIds: null,
      keyOwner: null,
    });

    // B must settle while A is still held. A global mutex fails this race.
    const winner = await Promise.race([
      b.then((value) => ({ source: "b", value })),
      new Promise((resolve) => setTimeout(() => resolve({ source: "timeout" }), 50)),
    ]);
    expect(winner.source).toBe("b");
    expect(winner.value.connectionId).toBe("provider-b-1");

    gateA.resolve();
    expect((await a).connectionId).toBe("provider-a-1");
  });

  it("does not serialize fill-first reads in the same provider", async () => {
    const firstGate = deferred();
    let calls = 0;
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => {
      calls++;
      if (calls === 1) await firstGate.promise;
      return [connection(provider, "same-1")];
    });

    const options = {
      settings: { fallbackStrategy: "fill-first" },
      allowedConnectionIds: null,
      keyOwner: null,
    };
    const first = getProviderCredentials("same-fill", null, "model", options);
    const second = getProviderCredentials("same-fill", null, "model", options);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);

    firstGate.resolve();
    await Promise.all([first, second]);
  });

  it("still serializes two selectors for the same provider", async () => {
    const firstGate = deferred();
    let calls = 0;
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => {
      calls++;
      if (calls === 1) await firstGate.promise;
      return [connection(provider, "same-1")];
    });

    const options = {
      settings: { fallbackStrategy: "round-robin" },
      allowedConnectionIds: null,
      keyOwner: null,
    };
    const first = getProviderCredentials("same", null, "model", options);
    const second = getProviderCredentials("same", null, "model", options);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });
});
