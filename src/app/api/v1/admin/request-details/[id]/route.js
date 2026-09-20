import { NextResponse } from "next/server";
import { adminApiGuard } from "@/lib/auth/adminApiGuard.js";
import { getRequestDetailById } from "@/lib/db/index.js";

/**
 * GET /api/v1/admin/request-details/[id] — full stored detail (bodies
 * included), gated the same way as the collection route.
 */
export async function GET(request, { params }) {
  const guardError = await adminApiGuard(request);
  if (guardError) return guardError;

  try {
    const { id } = await params;
    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json({ error: "Request detail not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error("[API] Failed to get admin request detail:", error);
    return NextResponse.json({ error: "Failed to fetch request detail" }, { status: 500 });
  }
}
