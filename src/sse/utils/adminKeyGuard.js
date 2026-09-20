import { getApiKeyRoutingContext } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// An admin key authenticates the dashboard REST API as its owner (see
// resourceScope.js); it must never carry LLM traffic, even when
// requireApiKey is off — that setting only gates whether a key is required
// at all, not which kind of key a caller presented.
export const ADMIN_KEY_ROUTING_ERROR = "Administration keys cannot route LLM traffic";

// Pure form for callers (chat.js) that already resolved the routing context
// for another reason and would otherwise re-fetch it.
export function adminKeyRefusal(kind, options) {
  if (kind !== "admin") return null;
  return errorResponse(HTTP_STATUS.FORBIDDEN, ADMIN_KEY_ROUTING_ERROR, options);
}

// Convenience form for the smaller /v1 handlers, which only track a boolean
// "is this key valid" today and have no routing context of their own to reuse.
export async function rejectAdminKey(apiKey, options) {
  if (!apiKey) return null;
  const { kind } = await getApiKeyRoutingContext(apiKey);
  return adminKeyRefusal(kind, options);
}
