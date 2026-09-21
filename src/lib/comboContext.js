import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { stripThinkingSuffix } from "open-sse/translator/concerns/thinkingUnified.js";
import { resolveProviderId } from "@/shared/constants/providers";

function isLockedForModel(conn, modelId) {
  const until = conn?.[`modelLock_${modelId}`] || conn?.modelLock___all;
  return !!until && new Date(until).getTime() > Date.now();
}

/**
 * The combo member a request would reach right now: the first entry whose
 * provider has an active connection not locked for that model. Falls back to
 * the first entry so a fully locked combo still reports something.
 * ponytail: mirrors the fallback strategy only; round-robin combos rotate per
 * request, so their "current" model is whichever member is listed first here.
 */
export function comboCurrentModel(combo, connections = []) {
  const entries = (Array.isArray(combo?.models) ? combo.models : [])
    .map((m) => (typeof m === "string" ? m : m?.id || m?.model || ""))
    .filter(Boolean)
    .map((full) => {
      const slash = full.indexOf("/");
      const alias = slash > 0 ? full.slice(0, slash) : full;
      const modelId = stripThinkingSuffix(slash > 0 ? full.slice(slash + 1) : "");
      return { providerId: resolveProviderId(alias), modelId };
    })
    .filter((e) => e.modelId);
  if (!entries.length) return null;
  const reachable = entries.find(({ providerId, modelId }) => connections.some(
    (c) => c.provider === providerId && c.isActive !== false && !isLockedForModel(c, modelId),
  ));
  return reachable || entries[0];
}

/** { contextWindow, maxOutput } of the combo's current member, or null. */
export function comboContextLimits(combo, connections = []) {
  const current = comboCurrentModel(combo, connections);
  if (!current) return null;
  const caps = getCapabilitiesForModel(current.providerId, current.modelId);
  const contextWindow = Number.isFinite(caps?.contextWindow) ? caps.contextWindow : null;
  const maxOutput = Number.isFinite(caps?.maxOutput) ? caps.maxOutput : null;
  return contextWindow || maxOutput ? { contextWindow, maxOutput, ...current } : null;
}
