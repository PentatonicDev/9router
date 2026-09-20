// Daily refresh of model capabilities from models.dev.
//
// Downloads the catalog, keeps only what differs from the hand-written tables,
// and writes it next to the database. Failures are swallowed on purpose: a
// stale or missing file just means those tables keep deciding on their own.

import fs from "node:fs";
import path from "node:path";
import { CATALOG_FILE, CATALOG_RAW_FILE, CATALOG_VERSION, invalidateCatalog, installCatalogSource } from "open-sse/providers/catalogOverride.js";
import { withLease } from "@/lib/db/leases.js";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const CATALOG_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 60000;

// Only one instance should hit models.dev per sync. Realistic duration: the
// fetch itself is bounded by FETCH_TIMEOUT_MS, and collectEntries()/build()/
// the two writeAtomic() calls are in-memory JS + local disk I/O, well under
// 10s even for the full 4.3MB catalog. TTL is double the worst case so a slow
// fetch is never pre-empted by a retrying instance mid-write.
export const CATALOG_LEASE_ID = "job:model-catalog-sync";
const CATALOG_LEASE_TTL_MS = 2 * (FETCH_TIMEOUT_MS + 10_000);

// Each instance has its own DATA_DIR/CATALOG_FILE, so a loser that only skips
// the fetch never gets a catalog of its own. The winner also mirrors its
// result into this shared kv row (works the same over SQLite and Postgres —
// see src/lib/db/helpers/kvStore.js) and a loser adopts it locally instead of
// calling models.dev itself.
const catalogKv = makeKv("modelCatalog");

export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;   // let the server boot and serve first requests
const RETRY_DELAY_MS = 30 * 60 * 1000;

const MODALITY_BY_INPUT = { image: "vision", pdf: "pdf", audio: "audioInput", video: "videoInput" };
// Ignore limit differences below this: gateways round 200000 vs 202752.
const LIMIT_TOLERANCE = 0.1;

// 9router provider id -> models.dev provider id: the same gateway under another
// name. Both halves of the catalog are stored against the local id, so this runs
// while building rather than on every lookup. Providers absent here keep whatever
// the local pattern table resolves; names that already match need no entry.
export const PROVIDER_ALIASES = {
  "glm": "zai",
  "glm-cn": "zhipuai",
  "claude": "anthropic",
  "gemini": "google",
  "kimi": "moonshotai",
  "kimi-cn": "moonshotai-cn",
  "qwen": "alibaba",
  "qwen-cn": "alibaba-cn",
  "zhipu": "zhipuai",
  "hunyuan": "tencent",
  "doubao": "volcengine",
  "cloudflare-ai": "cloudflare-workers-ai",
};

let state = { running: false, lastSync: null, lastError: null, lastResult: null, etag: null, fileVersion: null, syncedAt: null };
let timer = null;

export function getSyncState() {
  return { ...state, file: CATALOG_FILE, url: CATALOG_URL, intervalMs: SYNC_INTERVAL_MS };
}

// "zai-org/GLM-4.6V:free" -> "glm-4.6v"
function baseId(modelId) {
  const withoutVendor = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  return withoutVendor.toLowerCase().split(":")[0];
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, contents, "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

// Trimmed copy of the upstream catalog, kept for the add-models skill: same
// models, ~470KB instead of 4.3MB.
function slim(catalog) {
  const out = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const models = {};
    for (const [modelId, model] of Object.entries(provider?.models || {})) {
      models[modelId] = {
        i: (model?.modalities?.input || []).filter((x) => x !== "text"),
        c: model?.limit?.context,
        o: model?.limit?.output,
        r: model?.reasoning || undefined,
      };
    }
    out[providerId] = models;
  }
  return out;
}

export function build(catalog, entries) {
  // Upstream provider id -> the local ids it belongs to, taken from the registry
  // snapshot so a gateway listed upstream under another name is still filed
  // under the name requests arrive with. One upstream name can back more than one
  // local id (glm-cn and zhipu are both zhipuai) and each has to resolve; the
  // snapshot only covers the built-in registry, so an upstream provider it does
  // not mention keeps its own name.
  const localIds = new Map();
  for (const { provider } of entries) {
    const upstreamId = PROVIDER_ALIASES[provider] || provider;
    let locals = localIds.get(upstreamId);
    if (!locals) localIds.set(upstreamId, (locals = []));
    if (!locals.includes(provider)) locals.push(provider);
  }

  // Index once: the raw upstream record per provider+model for limits, and the
  // modalities each gateway declares for it.
  const byProvider = {};
  // Modalities are recorded per gateway upstream and gateways disagree about the
  // same weights — some do not proxy images at all — so the key is provider +
  // model. Keying by model id alone let short ids collide across vendors: "auto",
  // "free" and "efficient" are router modes in one catalog and model names in
  // another, so a router mode inherited a stranger's vision.
  const models = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const locals = localIds.get(providerId) || [providerId];
    const modelsById = {};
    const seen = new Set();
    for (const [modelId, model] of Object.entries(provider?.models || {})) {
      const id = baseId(modelId);
      modelsById[id] = model;
      // One entry per provider+model: several upstream ids can normalize to the
      // same model (claude-opus-4-thinking:1024, :8192, :32768 …) and must not
      // stack their modalities.
      if (seen.has(id)) continue;
      seen.add(id);
      const declared = {};
      for (const input of model?.modalities?.input || []) {
        const key = MODALITY_BY_INPUT[input];
        if (key) declared[key] = true;
      }
      if (Object.keys(declared).length) {
        // Filed under every local id requests arrive with, and under the upstream
        // id too: a custom provider node can carry the upstream name without
        // appearing in the registry snapshot, and nothing else would resolve for
        // it. The reader takes whichever key it is handed.
        for (const local of locals) models[`${local}:${id}`] = declared;
        if (!locals.includes(providerId)) models[`${providerId}:${id}`] = declared;
      }
    }
    byProvider[providerId] = modelsById;
  }

  // Limits belong to the gateway — each truncates differently — so only the
  // matching provider's own numbers are used, keyed by provider + model.
  const providers = {};
  for (const { provider, model, contextLength, current } of entries) {
    const alias = PROVIDER_ALIASES[provider];
    const upstream = catalog[provider] ? provider : (alias && catalog[alias] ? alias : null);
    const entry = upstream && byProvider[upstream]?.[baseId(model)];
    if (!entry) continue;

    const delta = {};
    const { context, output } = entry.limit || {};
    if (context > 0 && !contextLength
      && Math.abs(context - current.contextWindow) / current.contextWindow > LIMIT_TOLERANCE) {
      delta.contextWindow = context;
    }
    if (output > 0
      && Math.abs(output - current.maxOutput) / current.maxOutput > LIMIT_TOLERANCE) {
      delta.maxOutput = output;
    }
    if (Object.keys(delta).length) (providers[provider] || (providers[provider] = {}))[model] = delta;
  }

  return { models, providers };
}

// Snapshot every registered model with the capabilities the hand-written tables
// resolve on their own, so build() can tell which upstream values are a change.
//
// The previous catalog MUST be detached first. Leaving it installed makes each
// delta relative to the last one, so a value that still agrees with upstream
// looks like "no change" and is dropped — the file erases itself over two runs.
async function collectEntries() {
  const [{ default: registry }, { getCapabilitiesForModel, setCatalogSource }] = await Promise.all([
    import("open-sse/providers/registry/index.js"),
    import("open-sse/providers/capabilities.js"),
  ]);
  setCatalogSource(null);

  const entries = [];
  for (const provider of registry) {
    for (const model of provider.models || []) {
      entries.push({
        provider: provider.id,
        model: model.id,
        contextLength: model.contextLength,
        current: getCapabilitiesForModel(provider.id, model.id),
      });
    }
  }
  return entries;
}

// Talks to models.dev and writes CATALOG_FILE/CATALOG_RAW_FILE. Only ever runs
// inside the lease in syncModelCatalog() below — this is the "winner" half.
async function fetchAndWrite() {
  const headers = { accept: "application/json" };
  // A file written by an older schema has to be rebuilt even when upstream is
  // unchanged, so only ask upstream for a 304 when the file is current.
  if (state.etag && state.fileVersion === CATALOG_VERSION) headers["if-none-match"] = state.etag;
  const response = await fetch(CATALOG_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (response.status === 304) return { status: "unchanged" };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  // ~23ms to parse, once a day, on a server that is otherwise idle at this
  // point — not worth a worker thread.
  const catalog = await response.json();
  const etag = response.headers.get("etag") || null;
  const entries = await collectEntries();
  const { models, providers } = build(catalog, entries);
  const payload = { v: CATALOG_VERSION, etag, syncedAt: Date.now(), models, providers };
  const serialized = JSON.stringify(payload);

  writeAtomic(CATALOG_FILE, serialized);
  writeAtomic(CATALOG_RAW_FILE, JSON.stringify(slim(catalog)));
  // Best-effort: a loser adopts this through adoptFromKv() below. A failure
  // here just means the next winner's copy is what losers eventually pick up.
  await catalogKv.set("catalog", payload).catch((e) => console.warn(`[modelCatalog] kv share failed: ${e.message}`));

  state.etag = etag;
  state.fileVersion = CATALOG_VERSION;
  state.syncedAt = payload.syncedAt;
  invalidateCatalog();
  const result = {
    status: "updated",
    etag,
    bytes: Buffer.byteLength(serialized),
    models: Object.keys(models).length,
    providers: Object.keys(providers).length,
  };
  console.log(`[modelCatalog] ${result.models} models, ${result.providers} providers, ${(result.bytes / 1024).toFixed(1)}KB`);
  return result;
}

// Loser half: adopt the winning instance's already-fetched catalog from kv
// instead of calling models.dev itself. No-op when kv has nothing newer than
// what this instance already has on disk (including the very first tick
// across the whole fleet, before anyone has won yet).
async function adoptFromKv() {
  const shared = await catalogKv.get("catalog").catch(() => null);
  if (!shared?.syncedAt || shared.syncedAt <= (state.syncedAt || 0)) return { status: "unchanged" };

  writeAtomic(CATALOG_FILE, JSON.stringify(shared));
  state.etag = shared.etag || null;
  state.fileVersion = shared.v || CATALOG_VERSION;
  state.syncedAt = shared.syncedAt;
  invalidateCatalog();
  return { status: "adopted", etag: state.etag };
}

// Run one sync. Returns a summary, or null when it could not complete.
export async function syncModelCatalog() {
  if (state.running) return null;
  state.running = true;
  try {
    const { ran, result } = await withLease(CATALOG_LEASE_ID, CATALOG_LEASE_TTL_MS, fetchAndWrite);
    const outcome = ran ? result : await adoptFromKv();

    state.lastSync = Date.now();
    state.lastError = null;
    state.lastResult = outcome;
    return outcome;
  } catch (error) {
    state.lastError = error?.message || String(error);
    console.log(`[modelCatalog] sync failed: ${state.lastError}`);
    return null;
  } finally {
    // collectEntries() detaches the reader; put it back whatever happened.
    await installCatalogSource().catch(() => {});
    state.running = false;
  }
}

// The etag lives in the file we wrote, so a restart can resume from it instead
// of re-downloading 4.3MB to be told nothing changed.
function restoreEtag() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    state.etag = parsed.etag || null;
    state.fileVersion = parsed.v || 1;
    state.syncedAt = parsed.syncedAt || null;
    state.lastSync = fs.statSync(CATALOG_FILE).mtimeMs;
  } catch {
    state.etag = null;
    state.fileVersion = null;
  }
}

// Schedule the recurring sync. Disable entirely with MODEL_CATALOG_SYNC=off.
export function startModelCatalogSync() {
  if (timer) return;
  if (String(process.env.MODEL_CATALOG_SYNC || "").toLowerCase() === "off") return;
  restoreEtag();

  const schedule = (delay) => {
    timer = setTimeout(async () => {
      await syncModelCatalog();
      // Reschedule on whether we actually have a catalog now (state.syncedAt),
      // not on syncModelCatalog()'s return value — a loser with nothing to
      // adopt yet still resolves truthy ({status:"unchanged"}) and must retry
      // sooner than a full day, or it can go a whole cycle catalog-less.
      schedule(state.syncedAt ? SYNC_INTERVAL_MS : RETRY_DELAY_MS);
    }, delay);
    timer.unref?.();
  };
  schedule(STARTUP_DELAY_MS);
}
