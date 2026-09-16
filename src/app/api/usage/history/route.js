import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { getUsageVisibility, scopeUsageStats } from "@/lib/auth/usageScope";

export async function GET() {
  try {
    const stats = scopeUsageStats(await getUsageStats(), await getUsageVisibility());
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
