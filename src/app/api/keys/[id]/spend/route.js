import { NextResponse } from "next/server";
import { getApiKeyById, getProviderConnections } from "@/lib/localDb";
import { canSee, getScopeFilter } from "@/lib/auth/resourceScope";
import { getDb } from "@/lib/db/kysely.js";
import { getApiKeyConnectionBudgets, monthKeyUTC, TOTAL_PERIOD_KEY } from "@/lib/db/repos/spendLedgerRepo.js";
import { PROVIDERS } from "open-sse/providers/index.js";

// GET /api/keys/[id]/spend — spend-cap status per account this key is bound to:
// its configured budget (if any), the provider's billing model, and spend this
// period from the ledger. Unbound keys (no allowedConnectionIds) have nothing
// to report — a cap only ever applies to a bound account.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const filter = await getScopeFilter();
    const apiKey = await getApiKeyById(id);
    if (!apiKey || !canSee(apiKey, filter)) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const boundIds = apiKey.allowedConnectionIds;
    if (!boundIds?.length) return NextResponse.json({ spend: [] });

    const allConnections = await getProviderConnections();
    const bound = allConnections.filter((c) => boundIds.includes(c.id));
    const budgets = await getApiKeyConnectionBudgets(apiKey.key);

    const db = await getDb();
    const rows = await db.selectFrom("spendLedger").select(["connectionId", "periodKey", "costUsd"])
      .where("apiKey", "=", apiKey.key).where("connectionId", "in", bound.map((c) => c.id)).execute();
    const spentByConnPeriod = new Map(rows.map((r) => [`${r.connectionId}|${r.periodKey}`, Number(r.costUsd || 0)]));
    const month = monthKeyUTC();

    const spend = bound.map((c) => {
      const budget = budgets[c.id] || null;
      const periodKey = budget?.period === "total" ? TOTAL_PERIOD_KEY : month;
      return {
        connectionId: c.id,
        provider: c.provider,
        billing: PROVIDERS[c.provider]?.billing || "usage",
        budget,
        spentUsd: spentByConnPeriod.get(`${c.id}|${periodKey}`) || 0,
        periodKey,
      };
    });

    return NextResponse.json({ spend });
  } catch (error) {
    console.log("Error fetching key spend:", error);
    return NextResponse.json({ error: "Failed to fetch spend" }, { status: 500 });
  }
}
