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
    return { access: granted ? "granted" : "denied", error: null };
  } catch (err) {
    // Includes AccessDeniedException for the availability call itself, and any
    // network/throttling failure — never escalate a single model's check into
    // a discovery-wide failure, but surface *why* access reads "unknown".
    return { access: "unknown", error: humanizeBedrockError(err, "Checking model availability") };
  }
}

const ACCESS_RANK = { granted: 2, denied: 1, unknown: 0 };

// Runs GetFoundationModelAvailability once per id (caller already deduped the
// set) and folds failures into `errors`, deduped by message so N models
// failing for the same permission reason produce one line, not N.
async function resolveAccessById(client, modelIds, errors) {
  const accessById = new Map();
  if (modelIds.length === 0) return accessById;
  const seenErrors = new Set();
  await mapWithConcurrency(modelIds, ACCESS_CHECK_CONCURRENCY, async (modelId) => {
    const { access, error } = await checkModelAccess(client, modelId);
    accessById.set(modelId, access);
    if (error && !seenErrors.has(error)) {
      seenErrors.add(error);
      errors.push(error);
    }
  });
  return accessById;
}

function bestAccess(ids, accessById) {
  let best = "unknown";
  for (const id of ids) {
    const a = accessById.get(id);
    if (a && ACCESS_RANK[a] > ACCESS_RANK[best]) best = a;
  }
  return best;
}

// ACTIVE TEXT-modality models, on-demand or inference-profile-only alike —
// the superset profiles are checked against (many Claude/Llama/Nova models
// are INFERENCE_PROFILE-only and never appear in the on-demand list).
async function buildTextModelMap(client, errors, context) {
  const map = new Map();
  try {
    const res = await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }));
    for (const m of res.modelSummaries || []) {
      if (!m.modelId) continue;
      if (m.modelLifecycle?.status !== "ACTIVE") continue;
      map.set(m.modelId, {
        inferenceTypesSupported: m.inferenceTypesSupported || [],
        responseStreamingSupported: m.responseStreamingSupported !== false,
        name: m.modelName || m.modelId,
        vendor: m.providerName || vendorFromModelId(m.modelId),
      });
    }
  } catch (err) {
    errors.push(humanizeBedrockError(err, context));
  }
  return map;
}

function onDemandModelItemsFrom(textModelById) {
  const items = [];
  for (const [id, info] of textModelById) {
    if (!info.responseStreamingSupported) continue;
    if (!info.inferenceTypesSupported.includes("ON_DEMAND")) continue;
    items.push({ id, name: info.name, vendor: info.vendor, kind: "model", access: "unknown", streaming: true });
  }
  return items;
}

// region mode: concrete AWS region -> on-demand text models + the SYSTEM_DEFINED
// inference profiles that cover it.
async function discoverRegionMode(client, apiRegion, psd, errors) {
  const textModelById = await buildTextModelMap(client, errors, "Listing foundation models");
  const modelItems = onDemandModelItemsFrom(textModelById);

  const profileItems = [];
  const keptWrappedIds = new Set();
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
      let wrappedId = null;
      let wrappedInfo = null;
      for (const id of wraps) {
        const info = textModelById.get(id);
        if (info) { wrappedId = id; wrappedInfo = info; break; }
      }
      // Drop profiles that wrap no known TEXT model at all — these are
      // image/video/embedding profiles (stability.*, twelvelabs.*, ...) that
      // ListInferenceProfiles still returns but don't belong in a chat list.
      if (!wrappedInfo) continue;
      const profileItem = {
        id: p.inferenceProfileId,
        name: p.inferenceProfileName || p.inferenceProfileId,
        vendor: wrappedInfo.vendor || vendorFromModelId(wrappedId),
        kind: "profile",
        access: "unknown",
        streaming: wrappedInfo.responseStreamingSupported !== false,
        regions,
        wraps,
      };
      // Never hide non-matching profiles — only mark the ones that match the
      // configured prefix, so the operator can still see (and pick) the rest.
      if (psd.inferenceProfilePrefix) {
        profileItem.matchesPrefix = p.inferenceProfileId.startsWith(psd.inferenceProfilePrefix);
      }
      profileItems.push(profileItem);
      wraps.forEach((id) => keptWrappedIds.add(id));
    }
  } catch (err) {
    errors.push(humanizeBedrockError(err, "Listing inference profiles"));
  }

  // Access is checked once per foundation model id, over the union of
  // on-demand models and the models wrapped by kept profiles (a profile
  // wrapping an INFERENCE_PROFILE-only model has no "model" item of its own
  // to inherit access from otherwise). A profile's access is the best result
  // among the models it wraps.
  const idsToCheck = Array.from(new Set([...modelItems.map((i) => i.id), ...keptWrappedIds]));
  const accessById = await resolveAccessById(client, idsToCheck, errors);
  for (const item of modelItems) item.access = accessById.get(item.id) || "unknown";
  for (const p of profileItems) p.access = bestAccess(p.wraps, accessById);

  return [...modelItems, ...profileItems];
}

// global mode: "global" is a runtime-only pseudo-region for Bedrock's
// cross-region low-latency routing endpoint (bedrock-runtime.global.amazonaws.com)
// — the control plane has no such region, so discovery always talks to a
// concrete home region and only lists the "global."-prefixed SYSTEM_DEFINED
// profiles that route through it. There is no ListFoundationModels call here
// (no on-demand/text-modality list to cross-check against, unlike region
// mode) — but GetFoundationModelAvailability is a per-model-id call that
// works fine against the concrete home region, so access is resolved
// directly against the wrapped model ids.
async function discoverGlobalMode(client, errors) {
  const items = [];
  const keptWrappedIds = new Set();
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
        access: "unknown",
        streaming: true,
        wraps,
      });
      wraps.forEach((id) => keptWrappedIds.add(id));
    }
  } catch (err) {
    errors.push(humanizeBedrockError(err, "Listing global inference profiles"));
  }

  const accessById = await resolveAccessById(client, Array.from(keptWrappedIds), errors);
  for (const item of items) item.access = bestAccess(item.wraps, accessById);

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
  // (Checked against the raw list, before denied items are hidden below — a
  // discovery that succeeded but found only denied items is not a failure.)
  if (items.length === 0 && errors.length > 0) {
    return {
      at,
      region: apiRegion,
      mode,
      items: seededFallbackItems(),
      errors: [...errors, "Bedrock discovery failed; showing the built-in model list instead."],
      hidden: { denied: 0 },
    };
  }

  const deniedCount = items.filter((i) => i.access === "denied").length;
  const visibleItems = items.filter((i) => i.access !== "denied");
  return { at, region: apiRegion, mode, items: visibleItems, errors, hidden: { denied: deniedCount } };
}

const INVALID_CREDENTIAL_ERRORS = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ExpiredTokenException",
]);

// Cheap control-plane call used to validate a Bedrock credential in either
// authMethod, shared by /api/providers/validate and the per-connection
// "Test connection" (testUtils.js) — same client config bedrockClient.js
// already centralizes for the executor and discovery.
export async function probeBedrockCredential(credentials) {
  const client = createBedrockControlPlaneClient(credentials);
  try {
    await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }));
    return { valid: true, error: null };
  } catch (err) {
    if (INVALID_CREDENTIAL_ERRORS.has(err?.name)) {
      return { valid: false, error: "Invalid credentials" };
    }
    return { valid: false, error: err?.message || "Bedrock request failed" };
  }
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
