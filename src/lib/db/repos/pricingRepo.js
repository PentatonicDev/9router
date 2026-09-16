import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = await trx.selectFrom("kv").select("value")
        .where("scope", "=", "pricing").where("key", "=", provider).executeTakeFirst();
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      const value = stringifyJson(merged);
      await trx.insertInto("kv").values({ scope: "pricing", key: provider, value })
        .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
        .execute();
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    if (!model) {
      await trx.deleteFrom("kv").where("scope", "=", "pricing").where("key", "=", provider).execute();
      return;
    }
    const row = await trx.selectFrom("kv").select("value")
      .where("scope", "=", "pricing").where("key", "=", provider).executeTakeFirst();
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      await trx.deleteFrom("kv").where("scope", "=", "pricing").where("key", "=", provider).execute();
    } else {
      const value = stringifyJson(current);
      await trx.insertInto("kv").values({ scope: "pricing", key: provider, value })
        .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
        .execute();
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
