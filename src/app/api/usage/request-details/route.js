import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getApiKeys } from "@/lib/localDb";
import { maskApiKey } from "@/lib/db/helpers/maskKey.js";
import { getScopeFilter, canSee } from "@/lib/auth/resourceScope";
import { getUsageVisibility, canSeeUsageRow } from "@/lib/auth/usageScope";

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const apiKeyId = searchParams.get("apiKeyId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    const scopeFilter = await getScopeFilter();
    const visibility = await getUsageVisibility();

    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    // connectionId and apiKeyId come from the client, so both are checked
    // against what the caller may see before they reach the query.
    if (connectionId) {
      if (!canSeeUsageRow({ connectionId }, visibility)) {
        return NextResponse.json({ error: "Unknown connection" }, { status: 400 });
      }
      filter.connectionId = connectionId;
    }
    // Resolve the key id server-side; the secret never travels to the client.
    if (apiKeyId && apiKeyId !== "all") {
      const selectedKey = (await getApiKeys()).find((k) => k.id === apiKeyId && canSee(k, scopeFilter));
      if (!selectedKey) {
        return NextResponse.json({ error: "Unknown API key" }, { status: 400 });
      }
      filter.apiKey = selectedKey.key;
    }
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);

    // Redact conversation payloads: the stored details include full request
    // bodies (user prompts, tool calls) and provider responses. Returning them
    // wholesale lets any dashboard-authenticated user (or, if requireLogin is
    // disabled, anyone) read every user's conversation history. Keep the
    // metadata (model, tokens, latency, status) but drop message content.
    const keyNameByMasked = new Map(
      (await getApiKeys()).filter((k) => canSee(k, scopeFilter)).map((k) => [maskApiKey(k.key), k.name])
    );

    const redactedDetails = (result.details || [])
      .filter((d) => canSeeUsageRow(d, visibility))
      .map((d) => {
      const redacted = { ...d };
      for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
        if (redacted[key] !== undefined) {
          redacted[key] = { redacted: true };
        }
      }
      redacted.apiKeyName = d.apiKeyMasked
        ? (keyNameByMasked.get(d.apiKeyMasked) || d.apiKeyMasked)
        : null;
      return redacted;
    });

    return NextResponse.json({ ...result, details: redactedDetails });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
