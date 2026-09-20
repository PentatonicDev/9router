// Amazon Bedrock — live model/inference-profile discovery per connection.
// Cache + in-flight dedupe shape follows open-sse/shared/zedAuth.js
// resolveZedModels: a short-TTL cache keyed on the connection's credential
// material, plus a Promise map so two overlapping callers (e.g. the dashboard
// "Discover models" click racing /v1/models) share one set of AWS calls.
import {
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  GetFoundationModelAvailabilityCommand,
} from "@aws-sdk/client-bedrock";
import { createBedrockControlPlaneClient } from "./bedrockClient.js";
import bedrockRegistry from "../providers/registry/bedrock.js";

const MODEL_CACHE_TTL_MS = 15 * 60 * 1000;
const ACCESS_CHECK_CONCURRENCY = 5;
const FOUNDATION_MODEL_ARN_MARKER = "foundation-model/";

const modelCache = new Map();
const modelInflight = new Map();

function vendorFromModelId(id) {
  return String(id || "").split(".")[0] || "unknown";
}

function regionFromModelArn(arn) {
  // arn:aws:bedrock:{region}::foundation-model/{modelId}
  return String(arn || "").split(":")[3] || "";
}

function modelIdFromArn(arn) {
  const raw = String(arn || "");
  const idx = raw.indexOf(FOUNDATION_MODEL_ARN_MARKER);
  return idx === -1 ? "" : raw.slice(idx + FOUNDATION_MODEL_ARN_MARKER.length);
}

function uniqueModelIdsFromProfileModels(models) {
  const ids = (models || []).map((m) => modelIdFromArn(m?.modelArn)).filter(Boolean);
  return Array.from(new Set(ids));
}

// AccessDenied/any error here -> "unknown", never thrown: a single model's
// availability check must not fail the whole discovery (see caller).
function humanizeBedrockError(err, context) {
  const name = err?.name || "Error";
  const message = err?.message || String(err) || "Unknown error";
  const prefix = context ? `${context}: ` : "";
  if (name === "AccessDeniedException" || name === "UnrecognizedClientException") {
    return `${prefix}Not authorized to call Bedrock with this credential/region (${name}).`;
  }
  if (["UnauthorizedException", "ExpiredTokenException", "InvalidSignatureException"].includes(name)) {
    return `${prefix}AWS credentials were rejected (${name}).`;
  }
  if (name === "ValidationException") {
    return `${prefix}${message}`;
  }
  return `${prefix}${message} (${name})`;
}

async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

async function checkModelAccess(client, modelId) {
  try {
    const res = await client.send(new GetFoundationModelAvailabilityCommand({ modelId }));
    const granted =
      res.authorizationStatus === "AUTHORIZED" &&
      res.entitlementAvailability === "AVAILABLE" &&
      res.regionAvailability === "AVAILABLE" &&
      (!res.agreementAvailability || res.agreementAvailability.status === "AVAILABLE");
    return granted ? "granted" : "denied";
  } catch {
    // Includes AccessDeniedException for the availability call itself, and any
    // network/throttling failure — never escalate a single model's check into
    // a discovery-wide failure.
    return "unknown";
  }
}

// region mode: concrete AWS region -> on-demand text models + the SYSTEM_DEFINED
// inference profiles that cover it.
async function discoverRegionMode(client, apiRegion, psd, errors) {
  const modelItems = [];
  const modelById = new Map();

  try {
    const res = await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }));
    for (const m of res.modelSummaries || []) {
      if (!m.modelId) continue;
      if (m.modelLifecycle?.status !== "ACTIVE") continue;
      if (m.responseStreamingSupported === false) continue;
      if (!m.inferenceTypesSupported?.includes("ON_DEMAND")) continue;
      const item = {
        id: m.modelId,
        name: m.modelName || m.modelId,
        vendor: m.providerName || vendorFromModelId(m.modelId),
        kind: "model",
        access: "unknown",
        streaming: m.responseStreamingSupported !== false,
      };
      modelItems.push(item);
      modelById.set(item.id, item);
    }
  } catch (err) {
    errors.push(humanizeBedrockError(err, "Listing foundation models"));
  }

  // Access is per-model, checked once the model list is known, before
  // profiles (which inherit access from the model they wrap) are built.
  if (modelItems.length > 0) {
    await mapWithConcurrency(modelItems, ACCESS_CHECK_CONCURRENCY, async (item) => {
      item.access = await checkModelAccess(client, item.id);
    });
  }

  const profileItems = [];
  try {
    const res = await client.send(new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" }));
    for (const p of res.inferenceProfileSummaries || []) {
      if (!p.inferenceProfileId) continue;
      const wraps = uniqueModelIdsFromProfileModels(p.models);
      const regions = Array.from(
        new Set((p.models || []).map((m) => regionFromModelArn(m?.modelArn)).filter(Boolean)),
      );
      // Only list a profile when we can confirm it actually covers this region.
      // An empty `regions` means the ARNs didn't parse — "can't confirm" must
      // exclude, not include, so this is `||` (not `&&`) on the empty case.
      if (!regions.length || !regions.includes(apiRegion)) continue;
      const wrappedModel = wraps.map((id) => modelById.get(id)).find(Boolean);
      const profileItem = {
        id: p.inferenceProfileId,
        name: p.inferenceProfileName || p.inferenceProfileId,
        vendor: wrappedModel?.vendor || (wraps[0] ? vendorFromModelId(wraps[0]) : "unknown"),
        kind: "profile",
        access: wrappedModel?.access || "unknown",
        streaming: wrappedModel ? wrappedModel.streaming : true,
        regions,
        wraps,
      };
      // Never hide non-matching profiles — only mark the ones that match the
      // configured prefix, so the operator can still see (and pick) the rest.
      if (psd.inferenceProfilePrefix) {
        profileItem.matchesPrefix = p.inferenceProfileId.startsWith(psd.inferenceProfilePrefix);
      }
      profileItems.push(profileItem);
    }
  } catch (err) {
    errors.push(humanizeBedrockError(err, "Listing inference profiles"));
  }

  return [...modelItems, ...profileItems];
}

// global mode: "global" is a runtime-only pseudo-region for Bedrock's
// cross-region low-latency routing endpoint (bedrock-runtime.global.amazonaws.com)
// — the control-plane API (ListFoundationModels/ListInferenceProfiles/
// GetFoundationModelAvailability) has no such region, so discovery always
// talks to a concrete home region and only lists the "global."-prefixed
// SYSTEM_DEFINED profiles that route through it.
async function discoverGlobalMode(client, errors) {
  const items = [];
  try {
    const res = await client.send(new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" }));
    for (const p of res.inferenceProfileSummaries || []) {
      if (!p.inferenceProfileId?.startsWith("global.")) continue;
      const wraps = uniqueModelIdsFromProfileModels(p.models);
      items.push({
        id: p.inferenceProfileId,
        name: p.inferenceProfileName || p.inferenceProfileId,
        vendor: wraps[0] ? vendorFromModelId(wraps[0]) : "unknown",
        kind: "profile",
        // No sibling "model" items are listed in global mode, so there is
        // nothing to inherit access from — left "unknown" rather than guessed.
        access: "unknown",
        streaming: true,
        wraps,
      });
    }
  } catch (err) {
    errors.push(humanizeBedrockError(err, "Listing global inference profiles"));
  }
  return items;
}

function seededFallbackItems() {
  return (bedrockRegistry.models || []).map((m) => ({
    id: m.id,
    name: m.name,
    vendor: vendorFromModelId(m.id),
    kind: "model",
    access: "unknown",
    streaming: true,
  }));
}

async function discoverBedrockModels(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const mode = psd.region === "global" ? "global" : "region";
  const apiRegion = mode === "global" ? (psd.homeRegion || "us-east-1") : (psd.region || "us-east-1");
  const errors = [];

  const client = createBedrockControlPlaneClient({
    ...credentials,
    providerSpecificData: { ...psd, region: apiRegion },
  });

  let items;
  try {
    items = mode === "region"
      ? await discoverRegionMode(client, apiRegion, psd, errors)
      : await discoverGlobalMode(client, errors);
  } catch (err) {
    items = [];
    errors.push(humanizeBedrockError(err));
  }

  const at = new Date().toISOString();
  // Every call that could produce an item failed -> nothing real to show.
  // Fall back to the registry's seeded static list rather than an empty page.
  if (items.length === 0 && errors.length > 0) {
    return {
      at,
      region: apiRegion,
      mode,
      items: seededFallbackItems(),
      errors: [...errors, "Bedrock discovery failed; showing the built-in model list instead."],
    };
  }

  return { at, region: apiRegion, mode, items, errors };
}

function cacheKeyFor(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const secret = psd.authMethod === "iam" ? (psd.accessKeyId || "") : (credentials?.apiKey || "");
  return [
    psd.authMethod === "iam" ? "iam" : "api_key",
    psd.region || "us-east-1",
    psd.homeRegion || "",
    psd.endpoint || "",
    psd.inferenceProfilePrefix || "",
    secret.slice(-8),
  ].join("|");
}

/**
 * Resolve (and cache) the live Bedrock model/profile catalog for one
 * connection's credentials. Never throws — a total failure resolves to the
 * seeded registry list with `errors` populated instead.
 */
export async function resolveBedrockModels(credentials, options = {}) {
  const key = cacheKeyFor(credentials);
  const cached = modelCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.result;

  const existing = modelInflight.get(key);
  if (existing && !options.forceRefresh) return existing;

  const promise = (async () => {
    const result = await discoverBedrockModels(credentials);
    modelCache.set(key, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, result });
    return result;
  })();

  modelInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (modelInflight.get(key) === promise) modelInflight.delete(key);
  }
}

export function clearBedrockModelCache() {
  modelCache.clear();
  modelInflight.clear();
}
