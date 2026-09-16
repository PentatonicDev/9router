// Public API barrel — all DB functions
import { getDb } from "./kysely.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  getApiKeyAllowedConnectionIds,
  getApiKeyOwner,
  getApiKeyIdentity,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getDb();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: (await db.selectFrom("providerConnections").selectAll().execute()).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, owner: r.owner ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: (await db.selectFrom("providerNodes").selectAll().execute()).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: (await db.selectFrom("proxyPools").selectAll().execute()).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: (await db.selectFrom("apiKeys").selectAll().execute()).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, allowedConnectionIds: parseJson(r.allowedConnectionIds, null), tags: parseJson(r.tags, null), owner: r.owner ?? null, createdAt: r.createdAt })),
    combos: (await db.selectFrom("combos").selectAll().execute()).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), owner: r.owner ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of (await db.selectFrom("kv").select(["key","value"]).where("scope","=","modelAliases").execute())) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of (await db.selectFrom("kv").select(["key","value"]).where("scope","=","customModels").execute())) out.customModels.push(parseJson(r.value));
  for (const r of (await db.selectFrom("kv").select(["key","value"]).where("scope","=","mitmAlias").execute())) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of (await db.selectFrom("kv").select(["key","value"]).where("scope","=","pricing").execute())) out.pricing[r.key] = parseJson(r.value);

  // Every other kv scope, verbatim. The four above keep their shaped fields for
  // backward compatibility, but a scope added later (disabledModels,
  // hiddenGlobalCombos) would otherwise be dropped on every backup — silently,
  // since a restore simply came back without it.
  const SHAPED_SCOPES = new Set(["modelAliases", "customModels", "mitmAlias", "pricing"]);
  out.kv = (await db.selectFrom("kv").select(["scope", "key", "value"]).execute())
    .filter((r) => !SHAPED_SCOPES.has(r.scope))
    .map((r) => ({ scope: r.scope, key: r.key, value: r.value }));

  // Usage history is the account's record of what it spent; a restore that
  // dropped it would look like a working system with its ledger erased.
  out.usageHistory = await db.selectFrom("usageHistory").selectAll().orderBy("id", "asc").execute();
  out.usageDaily = await db.selectFrom("usageDaily").select(["dateKey", "data"]).execute();
  out.requestDetails = await db.selectFrom("requestDetails").selectAll().execute();

  return out;
}

// Replace-or-insert on a known key. Kysely emits the right upsert per dialect,
// which "INSERT OR REPLACE" (SQLite-only) could not.
async function upsertRow(trx, table, key, values) {
  const keys = Array.isArray(key) ? key : [key];
  const updates = Object.fromEntries(Object.entries(values).filter(([k]) => !keys.includes(k)));
  await trx.insertInto(table).values(values)
    .onConflict((oc) => {
      const target = keys.length > 1 ? oc.columns(keys) : oc.column(keys[0]);
      return Object.keys(updates).length ? target.doUpdateSet(updates) : target.doNothing();
    })
    .execute();
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getDb();

  await db.transaction().execute(async (trx) => {
    // Wipe all tables (keep _meta)
    await trx.deleteFrom("settings").execute();
    await trx.deleteFrom("providerConnections").execute();
    await trx.deleteFrom("providerNodes").execute();
    await trx.deleteFrom("proxyPools").execute();
    await trx.deleteFrom("apiKeys").execute();
    await trx.deleteFrom("combos").execute();
    // Every scope, not a fixed list: a backup carries the scopes it had, and a
    // partial wipe would leave rows from the previous database behind.
    await trx.deleteFrom("kv").execute();
    await trx.deleteFrom("usageHistory").execute();
    await trx.deleteFrom("usageDaily").execute();
    await trx.deleteFrom("requestDetails").execute();

    // Settings
    if (payload.settings) {
      const sdata = stringifyJson(payload.settings);
      await trx.insertInto("settings").values({ id: 1, data: sdata })
        .onConflict((oc) => oc.column("id").doUpdateSet({ data: sdata })).execute();
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, owner, createdAt, updatedAt, ...rest } = c;
      await upsertRow(trx, "providerConnections", "id", {
        id, provider, authType: authType || "oauth", name: name || null, email: email || null,
        priority: priority || null, isActive: isActive === false ? 0 : 1, owner: owner ?? null,
        data: stringifyJson(rest), createdAt: createdAt || new Date().toISOString(),
        updatedAt: updatedAt || new Date().toISOString(),
      });
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      await upsertRow(trx, "providerNodes", "id", {
        id, type: type || null, name: name || null, data: stringifyJson(rest),
        createdAt: createdAt || new Date().toISOString(), updatedAt: updatedAt || new Date().toISOString(),
      });
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      await upsertRow(trx, "proxyPools", "id", {
        id, isActive: isActive === false ? 0 : 1, testStatus: testStatus || "unknown",
        data: stringifyJson(rest), createdAt: createdAt || new Date().toISOString(),
        updatedAt: updatedAt || new Date().toISOString(),
      });
    }
    for (const k of payload.apiKeys || []) {
      await upsertRow(trx, "apiKeys", "id", {
        id: k.id, key: k.key, name: k.name || null, machineId: k.machineId || null,
        isActive: k.isActive === false ? 0 : 1,
        allowedConnectionIds: Array.isArray(k.allowedConnectionIds) && k.allowedConnectionIds.length ? stringifyJson(k.allowedConnectionIds) : null,
        tags: Array.isArray(k.tags) && k.tags.length ? stringifyJson(k.tags) : null,
        owner: k.owner ?? null, createdAt: k.createdAt || new Date().toISOString(),
      });
    }
    for (const c of payload.combos || []) {
      await upsertRow(trx, "combos", "id", {
        id: c.id, name: c.name, kind: c.kind || null, models: stringifyJson(c.models || []),
        owner: c.owner ?? null, createdAt: c.createdAt || new Date().toISOString(),
        updatedAt: c.updatedAt || new Date().toISOString(),
      });
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      await upsertRow(trx, "kv", ["scope", "key"], { scope: "modelAliases", key: a, value: stringifyJson(m) });
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      await upsertRow(trx, "kv", ["scope", "key"], { scope: "customModels", key: k, value: stringifyJson(m) });
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      await upsertRow(trx, "kv", ["scope", "key"], { scope: "mitmAlias", key: tool, value: stringifyJson(mappings || {}) });
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      await upsertRow(trx, "kv", ["scope", "key"], { scope: "pricing", key: provider, value: stringifyJson(models || {}) });
    }
    for (const r of payload.kv || []) {
      if (!r?.scope || r.key === undefined) continue;
      await upsertRow(trx, "kv", ["scope", "key"], { scope: r.scope, key: r.key, value: r.value });
    }

    for (const r of payload.usageHistory || []) {
      await trx.insertInto("usageHistory").values({
        timestamp: r.timestamp, provider: r.provider ?? null, model: r.model ?? null,
        connectionId: r.connectionId ?? null, apiKey: r.apiKey ?? null, endpoint: r.endpoint ?? null,
        promptTokens: r.promptTokens ?? 0, completionTokens: r.completionTokens ?? 0,
        cost: r.cost ?? 0, status: r.status ?? null, tokens: r.tokens ?? null, meta: r.meta ?? null,
      }).execute();
    }
    for (const r of payload.usageDaily || []) {
      await upsertRow(trx, "usageDaily", "dateKey", { dateKey: r.dateKey, data: r.data });
    }
    for (const r of payload.requestDetails || []) {
      await upsertRow(trx, "requestDetails", "id", {
        id: r.id, timestamp: r.timestamp, provider: r.provider ?? null, model: r.model ?? null,
        connectionId: r.connectionId ?? null, apiKey: r.apiKey ?? null,
        status: r.status ?? null, data: r.data,
      });
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getDb();
}
