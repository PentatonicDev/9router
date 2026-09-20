import { NextResponse } from "next/server";
import { adminApiGuard } from "@/lib/auth/adminApiGuard.js";
import { getRequestDetails } from "@/lib/db/index.js";

// Bulky fields dropped from each row unless ?full=1 is given. `response` is
// trimmed rather than dropped outright — finish_reason/error stay, since those
// are what an operator debugging from curl actually needs without the content.
const BULKY_FIELDS = ["request", "providerRequest", "providerResponse"];

function sanitizeDetail(detail, full) {
  if (full) return detail;
  const { response, ...rest } = detail;
  for (const field of BULKY_FIELDS) delete rest[field];
  if (response && typeof response === "object") {
    const trimmed = {};
    if (response.finish_reason !== undefined) trimmed.finish_reason = response.finish_reason;
    if (response.error !== undefined) trimmed.error = response.error;
    if (Object.keys(trimmed).length) rest.response = trimmed;
  }
  return rest;
}

/**
 * GET /api/v1/admin/request-details — raw request-details rows for an admin
 * API key, gated by settings.enableObservability. Same query params as the
 * dashboard's /api/usage/request-details, minus its dashboard-session scoping.
 */
export async function GET(request) {
  const guardError = await adminApiGuard(request);
  if (guardError) return guardError;

  try {
    const { searchParams } = new URL(request.url);

    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;

    if (page < 1) {
      return NextResponse.json({ error: "Page must be >= 1" }, { status: 400 });
    }
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json({ error: "PageSize must be between 1 and 100" }, { status: 400 });
    }

    const filter = { page, pageSize };
    for (const key of ["provider", "model", "connectionId", "status", "startDate", "endDate"]) {
      const value = searchParams.get(key);
      if (value) filter[key] = value;
    }

    const full = searchParams.get("full") === "1";
    const result = await getRequestDetails(filter);
    const details = (result.details || []).map((d) => sanitizeDetail(d, full));

    return NextResponse.json({ ...result, details });
  } catch (error) {
    console.error("[API] Failed to get admin request details:", error);
    return NextResponse.json({ error: "Failed to fetch request details" }, { status: 500 });
  }
}
