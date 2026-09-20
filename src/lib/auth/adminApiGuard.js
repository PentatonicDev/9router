import { NextResponse } from "next/server";
import { extractApiKey } from "@/sse/services/auth.js";
import { getApiKeyRoutingContext, getSettings } from "@/lib/db/index.js";
import { ADMIN_OWNER } from "@/lib/auth/resourceScope";

/**
 * Shared guard for admin-only observability endpoints (raw request-details API).
 * Order matters: the key is checked before the observability setting, so an
 * unauthenticated or non-admin caller cannot use the response to probe whether
 * observability is on.
 *
 * Returns a NextResponse error to send as-is, or null when the request may proceed.
 */
export async function adminApiGuard(request) {
  const key = extractApiKey(request);
  if (!key) return NextResponse.json({ error: "API key required" }, { status: 401 });

  const ctx = await getApiKeyRoutingContext(key);
  if (!ctx.valid || ctx.owner !== ADMIN_OWNER) {
    return NextResponse.json({ error: "admin API key required" }, { status: 403 });
  }

  const settings = await getSettings();
  if (settings.enableObservability !== true) {
    return NextResponse.json({ error: "observability disabled" }, { status: 403 });
  }

  return null;
}
