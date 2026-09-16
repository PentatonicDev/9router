import { NextResponse } from "next/server";
import { testSingleConnection } from "./testUtils.js";
import { canSee, getScopeFilter } from "@/lib/auth/resourceScope";
import { getProviderConnectionById } from "@/lib/localDb";

// POST /api/providers/[id]/test - Test connection
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection || !canSee(connection, await getScopeFilter())) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    const result = await testSingleConnection(id);

    if (result.error === "Connection not found") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({
      valid: result.valid,
      error: result.error,
      refreshed: result.refreshed || false,
    });
  } catch (error) {
    console.log("Error testing connection:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
