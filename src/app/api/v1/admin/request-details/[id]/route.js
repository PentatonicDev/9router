import { NextResponse } from "next/server";
import { requestDetailsAuth } from "@/lib/auth/requestDetailsAuth.js";
import { getUsageVisibilityForFilter, canSeeUsageRow } from "@/lib/auth/usageScope.js";
import { getRequestDetailById } from "@/lib/db/index.js";

/**
 * GET /api/v1/admin/request-details/[id] — full stored detail (bodies
 * included), gated the same way as the collection route.
 */
export async function GET(request, { params }) {
  const auth = await requestDetailsAuth(request);
  if (auth.error) return auth.error;

  try {
    const { id } = await params;
    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json({ error: "Request detail not found" }, { status: 404 });
    }
    const visibility = await getUsageVisibilityForFilter(auth.scopeFilter);
    if (visibility && !canSeeUsageRow(detail, visibility)) {
      // 404, not 403 — a row outside the caller's scope must look identical
      // to a nonexistent one, or the response leaks that it exists.
      return NextResponse.json({ error: "Request detail not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error("[API] Failed to get admin request detail:", error);
    return NextResponse.json({ error: "Failed to fetch request detail" }, { status: 500 });
  }
}
