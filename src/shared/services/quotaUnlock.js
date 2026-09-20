// Quota-vs-lock reconciler: providers can reset a quota window earlier than the
// `resets_at` we stored when they 429'd, leaving the account locked for hours with
// quota already free. Nothing else clears it — a locked account is filtered out of
// account selection, so it never gets the successful request that would unlock it.
import "open-sse/index.js";

import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { needsQuotaCheck, buildQuotaUnlockUpdate } from "@/shared/services/quotaUnlockRules";
import { QUOTA_UNLOCK_CONFIG } from "@/shared/constants/config";
import { withLease } from "@/lib/db/leases.js";
import { isNonServerRuntime } from "@/lib/runtimeEnv.js";
import * as log from "@/sse/utils/logger.js";

const C = QUOTA_UNLOCK_CONFIG;

// One instance reconciles a given tick across the whole deployment — otherwise
// every instance would spend its own usage call per locked account. Realistic
// duration: reconcileConnection costs at most one OAuth refresh + one forced
// usage fetch per locked connection; a locked account is already the abnormal
// case, so budgeting 15s/connection for up to ~20 simultaneously-locked
// accounts bounds a realistic tick at 20 * 15s = 300s. TTL is double that so a
// slow tick is never pre-empted mid-run by its own next-cycle claim.
export const UNLOCK_LEASE_ID = "job:quota-unlock";
const UNLOCK_LEASE_TTL_MS = 2 * 20 * 15_000; // 600_000ms

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__quotaUnlock ??= { interval: null, running: false });

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function reconcileConnection(conn, deps) {
  const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  if (connection.authType === "oauth") {
    const { connection: refreshed } = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = { ...connection, ...refreshed };
  }

  const usage = await deps.getUsageForProvider(connection, proxyOptions, { force: true });
  const update = buildQuotaUnlockUpdate(connection, usage);
  if (!update) return false;

  await deps.updateProviderConnection(connection.id, update);
  const name = connection.displayName || connection.name || connection.email || connection.id.slice(0, 8);
  console.log(`[QuotaUnlock] ${connection.provider}:${name}: quota is free, locks cleared`);
  return true;
}

function createDefaultDeps() {
  return {
    getProviderConnections,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    getUsageForProvider,
  };
}

export async function runQuotaUnlockTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    await withLease(UNLOCK_LEASE_ID, UNLOCK_LEASE_TTL_MS, async ({ renew }) => {
      const connections = await deps.getProviderConnections({ isActive: true });
      for (const conn of connections.filter((c) => needsQuotaCheck(c))) {
        try {
          // Renew per connection, not just once for the whole tick — a run over
          // many locked accounts can otherwise outlive the TTL and get pre-empted
          // mid-loop by another instance's claim. If renew() reports we no longer
          // hold the lease, another instance already won it — stop instead of
          // continuing to process the same connections concurrently.
          if (!(await renew())) break;
          await reconcileConnection(conn, deps);
        } catch (e) {
          console.warn(`[QuotaUnlock] ${conn.provider}:${conn.id}: ${e.message}`);
        }
      }
    }, { onSkip: () => log.debug("QuotaUnlock", "lease held by another instance, skip") });
  } catch (e) {
    console.warn("[QuotaUnlock] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startQuotaUnlock() {
  if (isNonServerRuntime()) return;
  if (g.interval) return;
  console.log("[QuotaUnlock] scheduler started");
  runQuotaUnlockTick().catch(() => {});
  g.interval = setInterval(() => { runQuotaUnlockTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQuotaUnlock() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[QuotaUnlock] scheduler stopped");
}
