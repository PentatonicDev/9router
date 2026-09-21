import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runSearch (via searchForChat) still calls getCombos for the combo-expansion
// check even for a plain provider id — stub it out rather than touch the DB.
vi.mock("@/lib/localDb", () => ({ getCombos: vi.fn().mockResolvedValue([]) }));

const { searchForChat } = await import("../../src/sse/services/webSearchRunner.js");

const originalFetch = global.fetch;

describe("webSearchRunner.searchForChat", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("hits the admin-configured SearXNG host — blocked by the SSRF guard for a client override, allowed here via trustedBaseUrl — and maps results into the contract shape", async () => {
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        {
          title: "Result one",
          url: "https://example.com/1",
          content: "First snippet",
          publishedDate: "2026-01-01T00:00:00Z",
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const settings = { webSearchSource: "searxng", searxngUrl: "http://searxng.internal:8080" };
    const result = await searchForChat({ query: "test query", settings });

    expect(result).toEqual({
      ok: true,
      provider: "searxng",
      results: [
        { title: "Result one", url: "https://example.com/1", snippet: "First snippet", published_at: "2026-01-01T00:00:00Z" },
      ],
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [requestUrl] = global.fetch.mock.calls[0];
    // "searxng.internal" ends in the SSRF guard's blocked ".internal" suffix —
    // fetchPublic would throw before ever reaching fetch(). Only the
    // trustedBaseUrl path (plain fetch, admin-set URL) gets here.
    expect(new URL(requestUrl).hostname).toBe("searxng.internal");
  });

  it("maps a non-2xx upstream response to ok:false with the same status", async () => {
    global.fetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const settings = { webSearchSource: "searxng", searxngUrl: "http://searxng.internal:8080" };
    const result = await searchForChat({ query: "test query", settings });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(typeof result.error).toBe("string");
  });

  it("auto source (webSearchSource unset) falls back to searxng when searxngUrl is configured", async () => {
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const settings = { webSearchSource: "", searxngUrl: "http://searxng.internal:8080" };
    const result = await searchForChat({ query: "q", settings });

    expect(result).toEqual({ ok: true, provider: "searxng", results: [] });
  });
});
