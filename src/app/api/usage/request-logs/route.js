import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";
import { getUsageVisibility, canSeeUsageRow } from "@/lib/auth/usageScope";

export async function GET() {
  try {
    const visibility = await getUsageVisibility();
    const logs = await getRecentLogs(200, (row) => canSeeUsageRow(row, visibility));
    return NextResponse.json(logs);
  } catch (error) {
    console.error("[API ERROR] /api/usage/logs failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
