import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KiroService } from "../../src/lib/oauth/services/kiro.js";
import { fetchKiroProfileArn } from "../../src/lib/oauth/providerHelpers.js";

/**
 * Regression tests for Kiro API-key auth.
 *
 * KiroService.validateApiKey validates against the Amazon Q model catalog and
 * returns an account-bound credential without inventing a profileArn.
 *
 * Note: OAuth (Builder ID / IDC) profileArn resolution is handled upstream by
 * fetchKiroProfileArn in providers.js and is covered there — not here.
 */
describe("kiro API-key auth (KiroService.validateApiKey)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("validates an API key against Amazon Q without inventing profileArn", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ modelId: "claude-opus-5" }] }),
    });

    const svc = new KiroService();
    const cred = await svc.validateApiKey("  my-secret-key  ");

    expect(cred).toEqual({
      accessToken: "my-secret-key",
      refreshToken: null,
      profileArn: null,
      region: "us-east-1",
      authMethod: "api_key",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR"
    );
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer my-secret-key");
    expect(init.headers.TokenType).toBe("API_KEY");
  });

  it("rejects an empty API key without a network call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    await expect(svc.validateApiKey("   ")).rejects.toThrow("API key is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a validation error when the key is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    const svc = new KiroService();
    await expect(svc.validateApiKey("bad-key")).rejects.toThrow(
      /API key validation failed/
    );
  });

  it("rejects a 200 response with an empty model catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });
    const svc = new KiroService();
    await expect(svc.validateApiKey("empty-key")).rejects.toThrow(
      /returned no available models/
    );
  });
});

/**
 * IDC accounts have no shared default profileArn, so inference 400s with
 * "profileArn is required" unless resolution succeeds. The path-style
 * /ListAvailableProfiles route is deprecated; resolution must POST to the
 * region root with x-amz-target, in the region the token was minted in.
 */
describe("fetchKiroProfileArn", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("POSTs to the token's region root with x-amz-target, not the path route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: [{ arn: "arn:aws:codewhisperer:eu-central-1:111:profile/EU" }],
      }),
    });

    const arn = await fetchKiroProfileArn("idc-token", "eu-central-1");

    expect(arn).toBe("arn:aws:codewhisperer:eu-central-1:111:profile/EU");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://codewhisperer.eu-central-1.amazonaws.com");
    expect(url).not.toContain("/ListAvailableProfiles");
    expect(init.headers["x-amz-target"]).toBe(
      "AmazonCodeWhispererService.ListAvailableProfiles"
    );
    expect(init.headers.Authorization).toBe("Bearer idc-token");
  });

  it("prefers the profile matching the requested region", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: [
          { arn: "arn:aws:codewhisperer:us-east-1:111:profile/US" },
          { arn: "arn:aws:codewhisperer:sa-east-1:111:profile/SA" },
        ],
      }),
    });

    expect(await fetchKiroProfileArn("t", "sa-east-1")).toBe(
      "arn:aws:codewhisperer:sa-east-1:111:profile/SA"
    );
  });

  it("defaults to us-east-1 when no region is given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [{ arn: "arn:a:b:us-east-1:1:profile/X" }] }),
    });

    await fetchKiroProfileArn("t");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://codewhisperer.us-east-1.amazonaws.com"
    );
  });

  it("fails soft (null) on rejection, empty list and missing token", async () => {
    expect(await fetchKiroProfileArn("")).toBeNull();

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "bearer token invalid",
    });
    expect(await fetchKiroProfileArn("t", "us-east-1")).toBeNull();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [] }),
    });
    expect(await fetchKiroProfileArn("t", "us-east-1")).toBeNull();
  });

  it("fails soft on an invalid region instead of building a bogus host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await fetchKiroProfileArn("t", "not a region")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
