// Spends a free Claude "limit reset" grant shortly before it expires, so a grant
// nobody clicked is not lost. Consuming a grant is irreversible.
import "open-sse/index.js";

import { getProviderConnections } from "@/lib/localDb";
import { getClaudeUsage, consumeClaudeResetGrant } from "open-sse/services/usage/claude.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { withLease } from "@/lib/db/leases.js";
import { isNonServerRuntime } from "@/lib/runtimeEnv.js";
import * as log from "@/sse/utils/logger.js";

const TICK_MS = 15 * 60 * 1000;
const EXPIRY_WINDOW_MS = 60 * 60 * 1000;
export const RESET_LEASE_ID = "job:claude-reset-auto-apply";
const RESET_LEASE_TTL_MS = 10 * 60 * 1000;

const g = (global.__claudeResetAutoApply ??= { interval: null, running: false });

// Grants expiring within the window, soonest first. One per tick per
// connection: the first refills the limits, so a second one would be wasted.
export function pickExpiringGrant(resetCredits, nowMs = Date.now()) {
  const candidates = (resetCredits?.grants || []).filter((grant) => {
    const endsMs = new Date(grant.endsAt).getTime();
    return grant.usableNow && !grant.paused && grant.resetsLeft > 0
      && Number.isFinite(endsMs) && endsMs > nowMs && endsMs - nowMs <= EXPIRY_WINDOW_MS;
  });
  candidates.sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt));
  return candidates[0] || null;
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function applyIfExpiring(conn) {
  const proxyOptions = buildProxyOptions(await resolveConnectionProxyConfig(conn.providerSpecificData));
  const { connection } = await refreshAndUpdateCredentials(conn, false, proxyOptions);
  const accessToken = connection?.accessToken || conn.accessToken;
  const usage = await getClaudeUsage(accessToken, proxyOptions, { force: true });
  const grant = pickExpiringGrant(usage?.resetCredits);
  if (!grant) return;

  const name = conn.displayName || conn.name || conn.email || conn.id.slice(0, 8);
  const result = await consumeClaudeResetGrant(accessToken, grant.id, proxyOptions);
  if (result.ok) {
    console.log(`[ClaudeResetAuto] ${name}: applied grant "${grant.label || grant.id}" expiring ${grant.endsAt} (${result.resetsLeft ?? "?"} left)`);
  } else {
    console.warn(`[ClaudeResetAuto] ${name}: grant ${grant.id} not applied (${result.status} ${result.reason || result.result || result.message || "unknown"})`);
  }
}

export async function runClaudeResetAutoApplyTick(state = g) {
  if (state.running) return;
  state.running = true;
  try {
    await withLease(RESET_LEASE_ID, RESET_LEASE_TTL_MS, async ({ renew }) => {
      const connections = await getProviderConnections({ provider: "claude", isActive: true });
      for (const conn of connections.filter((c) => c.authType === "oauth")) {
        if (!(await renew())) break;
        try {
          await applyIfExpiring(conn);
        } catch (e) {
          console.warn(`[ClaudeResetAuto] ${conn.id}: ${e.message}`);
        }
      }
    }, { onSkip: () => log.debug("ClaudeResetAuto", "lease held by another instance, skip") });
  } catch (e) {
    console.warn("[ClaudeResetAuto] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startClaudeResetAutoApply() {
  if (isNonServerRuntime() || g.interval) return;
  console.log("[ClaudeResetAuto] scheduler started (every 15min, applies grants expiring within 1h)");
  runClaudeResetAutoApplyTick().catch(() => {});
  g.interval = setInterval(() => { runClaudeResetAutoApplyTick().catch(() => {}); }, TICK_MS);
  if (g.interval.unref) g.interval.unref();
}
