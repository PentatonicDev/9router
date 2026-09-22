// Account selection needs serialization only inside one provider pool. A global
// mutex made unrelated providers wait behind each other; per-provider locks keep
// round-robin updates safe while independent pools proceed concurrently.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelLockKey } from "../../open-sse/services/accountFallback.js";

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

  it("inspects eligible accounts without changing round-robin state", async () => {
    const locked = connection("claude", "locked");
    locked.authType = "oauth";
    locked[getModelLockKey("model-a")] = new Date(Date.now() + 60_000).toISOString();
    const usage = connection("claude", "usage");
    usage.authType = "apikey";
    const subscription = connection("claude", "subscription");
    subscription.authType = "access_token";
    mocks.getProviderConnections.mockResolvedValue([locked, usage, subscription]);
    const options = { settings: { fallbackStrategy: "round-robin" }, keyOwner: null, allowedConnectionIds: ["locked", "usage"] };

    expect(await getProviderCredentials("claude", null, "model-a", { ...options, inspectOnly: true }))
      .toEqual({ available: true, subscription: false });
    expect(await getProviderCredentials("claude", null, "model-b", { ...options, inspectOnly: true }))
      .toEqual({ available: true, subscription: true });
    expect(await getProviderCredentials("claude", null, "model-a", { ...options, inspectOnly: true, allowedConnectionIds: ["locked"] }))
      .toEqual({ available: false, subscription: false });
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps no-auth providers available without connection rows", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    expect(await getProviderCredentials("mimo-free", null, "mimo-v2", { inspectOnly: true }))
      .toEqual({ available: true, subscription: false, free: true });
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it("prefers a subscription in fill-first, but honors explicit account pinning", async () => {
    const usage = connection("claude", "usage");
    usage.authType = "apikey";
    const subscription = connection("claude", "subscription");
    subscription.authType = "oauth";
    mocks.getProviderConnections.mockResolvedValue([usage, subscription]);
    const options = { settings: { fallbackStrategy: "fill-first" }, keyOwner: null, allowedConnectionIds: null, preferSubscription: true };

    expect((await getProviderCredentials("claude", null, "model", options)).connectionId).toBe("subscription");
    expect((await getProviderCredentials("claude", null, "model", { ...options, preferredConnectionId: "usage" })).connectionId).toBe("usage");
    expect((await getProviderCredentials("claude", null, "model", { ...options, allowedConnectionIds: ["usage"] })).connectionId).toBe("usage");
  });

  it("prefers a subscription without breaking round-robin within subscriptions", async () => {
    const usage = connection("claude", "usage");
    usage.authType = "apikey";
    const subscription = connection("claude", "subscription");
    subscription.authType = "oauth";
    mocks.getProviderConnections.mockResolvedValue([usage, subscription]);
    const credentials = await getProviderCredentials("claude", null, "model", {
      settings: { fallbackStrategy: "round-robin" }, keyOwner: null, allowedConnectionIds: null, preferSubscription: true,
    });
    expect(credentials.connectionId).toBe("subscription");
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("subscription", expect.any(Object));
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
