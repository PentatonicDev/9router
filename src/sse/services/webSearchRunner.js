import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getProvidersByKind, resolveProviderId } from "@/shared/constants/providers.js";
import { runSearch } from "../handlers/search.js";

// domain_filter combines allow (plain entries) and block (entries prefixed
// with "-", per parseDomainFilter in open-sse/handlers/search/callers.js)
// into the one array the search API expects. Not every provider builder
// honors exclusions (e.g. searxng ignores domain_filter entirely).
function buildDomainFilter(allowedDomains, blockedDomains) {
  const allow = allowedDomains?.length ? allowedDomains : [];
  const block = blockedDomains?.length ? blockedDomains.map((d) => `-${d}`) : [];
  const combined = [...allow, ...block];
  return combined.length ? combined : null;
}

// Auto source resolution: an admin-set SearXNG URL wins (it's free and
// self-hosted); otherwise the first webSearch provider that's actually usable
// — noAuth, or has at least one active connection.
async function resolveAutoSource(settings) {
  if (typeof settings.searxngUrl === "string" && settings.searxngUrl.trim()) return "searxng";

  for (const provider of getProvidersByKind("webSearch")) {
    // searxng is noAuth but only reachable when someone pointed at an instance.
    if (provider.id === "searxng" && !process.env.SEARXNG_URL) continue;
    if (provider.noAuth) return provider.id;
    const connections = await getProviderConnections({ provider: provider.id, isActive: true });
    if (connections.length > 0) return provider.id;
  }
  return null;
}

function extractErrorMessage(data, status) {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  return `Search failed with status ${status}`;
}

/**
 * Run a web search for the gateway-side web_search tool emulation, reusing
 * the same auth/combo/fallback path as the /v1/search HTTP handler.
 *
 * @returns {Promise<{ ok: true, provider: string, results: Array<{ title: string, url: string, snippet: string, published_at: string|null }> } | { ok: false, status: number, error: string }>}
 */
export async function searchForChat({ query, maxResults = 5, allowedDomains = null, blockedDomains = null, settings, apiKey = null, log }) {
  try {
    const configuredSource = typeof settings.webSearchSource === "string" ? settings.webSearchSource.trim() : "";
    const source = configuredSource ? resolveProviderId(configuredSource) : await resolveAutoSource(settings);

    if (!source) {
      return { ok: false, status: 503, error: "No web search provider configured" };
    }

    const domainFilter = buildDomainFilter(allowedDomains, blockedDomains);
    const body = {
      query,
      max_results: maxResults,
      ...(domainFilter ? { domain_filter: domainFilter } : {}),
    };

    const response = await runSearch(body, source, apiKey, settings);
    const status = response.status;
    const data = await response.json().catch(() => null);

    if (status < 200 || status >= 300) {
      return { ok: false, status, error: extractErrorMessage(data, status) };
    }

    const results = (data?.results || []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.snippet ?? "",
      published_at: r.published_at ?? null,
    }));

    return { ok: true, provider: source, results };
  } catch (err) {
    log?.error?.("WEBSEARCH", `searchForChat failed: ${err.message}`);
    return { ok: false, status: 502, error: err?.message || "Search failed" };
  }
}
