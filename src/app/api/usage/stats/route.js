import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { getApiKeys } from "@/lib/localDb";
import { getScopeFilter, canSee } from "@/lib/auth/resourceScope";
import { getUsageVisibility, scopeUsageStats } from "@/lib/auth/usageScope";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    // Clients pass the key's id, never the secret itself; the raw key stays
    // server-side and is only used to match usage rows.
    const apiKeyId = searchParams.get("apiKeyId");
    const scopeFilter = await getScopeFilter();
    const apiKeys = (await getApiKeys()).filter((k) => canSee(k, scopeFilter));
    const selectedKey = apiKeyId && apiKeyId !== "all" ? apiKeys.find((k) => k.id === apiKeyId) : null;
    if (apiKeyId && apiKeyId !== "all" && !selectedKey) {
      return NextResponse.json({ error: "Unknown API key" }, { status: 400 });
    }

    const rawStats = await getUsageStats(period, { apiKey: selectedKey?.key || null });
    const stats = scopeUsageStats(rawStats, await getUsageVisibility());
    const apiKeyOptions = apiKeys.map((k) => ({ id: k.id, name: k.name }));
    return NextResponse.json({ ...stats, apiKeyOptions });
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
