import { NextResponse } from "next/server";
import { canSee, getScopeFilter } from "@/lib/auth/resourceScope";
import { getProviderConnectionById } from "@/models";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveBedrockModels } from "open-sse/services/bedrockModels.js";

// POST /api/providers/[id]/discover — re-run discovery for an existing Bedrock
// connection (forceRefresh, bypassing the cache) and persist the result on
// providerSpecificData.discoveredModels so /v1/models and the dashboard pick
// it up without a live call on every request.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection || !canSee(connection, await getScopeFilter())) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    if (connection.provider !== "bedrock") {
      return NextResponse.json({ error: "Not a Bedrock connection" }, { status: 400 });
    }

    const credentials = {
      apiKey: connection.apiKey,
      providerSpecificData: connection.providerSpecificData || {},
    };
    const discovery = await resolveBedrockModels(credentials, { forceRefresh: true });

    await updateProviderCredentials(id, {
      providerSpecificData: {
        discoveredModels: { at: discovery.at, items: discovery.items, errors: discovery.errors },
      },
      existingProviderSpecificData: connection.providerSpecificData || {},
    });

    return NextResponse.json({ discovery });
  } catch (error) {
    console.log("Error running Bedrock discovery:", error?.message || error);
    return NextResponse.json({ error: "Failed to discover Bedrock models" }, { status: 500 });
  }
}
