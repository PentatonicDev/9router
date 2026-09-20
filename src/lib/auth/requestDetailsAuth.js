import { NextResponse } from "next/server";
import { extractApiKey } from "@/sse/services/auth.js";
import { getApiKeyRoutingContext, getSettings } from "@/lib/db/index.js";
import { ADMIN_OWNER, isScopeEnabled, ssoAdminsFor } from "@/lib/auth/resourceScope";

/**
 * Guard + identity resolver for the request-details observability API.
 * Any active, OWNED key passes (no "management" flag needed — that's a
 * separate, dashboard-management API key flag). Gated on requireLogin===true
 * AND enableObservability===true: an explicit double opt-in, not this
 * codebase's usual `!== false` default-on convention, because this endpoint
 * exposes raw request/response bodies and must stay off unless both are
 * turned on on purpose.
 * Key check runs before the settings check so a bad key can't be used to
 * probe whether observability is enabled.
 *
 * Returns `{ error }` (a NextResponse to send as-is) or `{ identity, scopeFilter }`
 * where `scopeFilter` is `{ owner }` for a non-admin caller under
 * scopeResourcesByUser, or null when the caller may see everything.
 */
export async function requestDetailsAuth(request) {
  const key = extractApiKey(request);
  if (!key) return { error: NextResponse.json({ error: "API key required" }, { status: 401 }) };

  const ctx = await getApiKeyRoutingContext(key);
  if (!ctx.valid || !ctx.owner) {
    return { error: NextResponse.json({ error: "active, owned API key required" }, { status: 403 }) };
  }

  const settings = await getSettings();
  if (!(settings.requireLogin === true && settings.enableObservability === true)) {
    return { error: NextResponse.json({ error: "observability disabled" }, { status: 403 }) };
  }

  const isAdmin = ctx.owner === ADMIN_OWNER || ssoAdminsFor(settings).includes(ctx.owner);
  const scopeFilter = isScopeEnabled(settings) && !isAdmin ? { owner: ctx.owner } : null;
  return { identity: { isAdmin, owner: ctx.owner }, scopeFilter };
}
