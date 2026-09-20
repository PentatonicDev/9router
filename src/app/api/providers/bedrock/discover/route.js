import { NextResponse } from "next/server";
import { resolveBedrockModels } from "open-sse/services/bedrockModels.js";

// POST /api/providers/bedrock/discover — preview discovery for the Add-connection
// form, BEFORE the connection exists. Body is the same shape AddApiKeyModal sends
// on save (apiKey + providerSpecificData); nothing is persisted here, and the
// credentials in the body are used for this call only (never logged).
export async function POST(request) {
  try {
    const body = await request.json();
    const providerSpecificData = (body?.providerSpecificData && typeof body.providerSpecificData === "object")
      ? body.providerSpecificData
      : {};

    const credentials = { apiKey: body?.apiKey || "", providerSpecificData };
    const discovery = await resolveBedrockModels(credentials);
    return NextResponse.json({ discovery });
  } catch (error) {
    console.log("Error previewing Bedrock discovery:", error?.message || error);
    return NextResponse.json({ error: "Failed to discover Bedrock models" }, { status: 500 });
  }
}
