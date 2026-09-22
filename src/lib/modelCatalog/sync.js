// Refresh model metadata from models.dev every 3 hours. On failure, the last
// catalog stays available and hardcoded tables cover missing entries.

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

export const SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;   // let the server boot and serve first requests
const RETRY_DELAY_MS = 30 * 60 * 1000;

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
  "kilo-gateway": "kilo",
};

let state = { running: false, lastSync: null, lastError: null, lastResult: null, etag: null, fileVersion: null, syncedAt: null };
let timer = null;

export function getSyncState() {
  return { ...state, file: CATALOG_FILE, url: CATALOG_URL, intervalMs: SYNC_INTERVAL_MS };
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
        t: model?.tool_call === false ? false : undefined,
        $: model?.cost?.input || undefined,
      };
    }
    out[providerId] = models;
  }
  return out;
}

export function build(catalog, entries) {
  const localIds = new Map();
  for (const { provider } of entries) {
    const upstreamId = PROVIDER_ALIASES[provider] || provider;
    let locals = localIds.get(upstreamId);
    if (!locals) localIds.set(upstreamId, (locals = []));
    if (!locals.includes(provider)) locals.push(provider);
  }

  const models = {};
  const providers = {};
  const pricing = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const locals = new Set([providerId, ...(localIds.get(providerId) || [])]);
    const upstreamModels = provider?.models || {};
    const shortIds = new Map();
    for (const id of Object.keys(upstreamModels)) {
      const short = id.toLowerCase().split("/").pop();
      shortIds.set(short, shortIds.has(short) ? null : id);
    }

    for (const [modelId, model] of Object.entries(upstreamModels)) {
      const id = modelId.toLowerCase();
      const short = id.split("/").pop();
      const keys = [id];
      if (short !== id && shortIds.get(short) === modelId) keys.push(short);
      const inputs = new Set(model?.modalities?.input || []);
      const outputs = new Set(model?.modalities?.output || []);
      const declared = {
        vision: inputs.has("image") || inputs.has("video"),
        pdf: inputs.has("pdf"),
        audioInput: inputs.has("audio"),
        videoInput: inputs.has("video"),
        imageOutput: outputs.has("image"),
        audioOutput: outputs.has("audio"),
        reasoning: model?.reasoning === true,
        tools: model?.tool_call !== false,
      };
      const { context, output } = model?.limit || {};
      const limits = {};
      if (context > 0) limits.contextWindow = context;
      if (output > 0) limits.maxOutput = output;

      const cost = model?.cost;
      let mapped;
      if (cost && typeof cost.input === "number" && typeof cost.output === "number") {
        mapped = { input: cost.input, output: cost.output, reasoning: cost.reasoning ?? cost.output };
        if (typeof cost.cache_read === "number") mapped.cached = cost.cache_read;
        if (typeof cost.cache_write === "number") mapped.cache_creation = cost.cache_write;
        if (cost.tiers?.length) mapped.tiers = cost.tiers;
        else if (cost.context_over_200k) mapped.context_over_200k = cost.context_over_200k;
      }

      for (const local of locals) {
        for (const key of keys) {
          models[`${local}:${key}`] = declared;
          if (Object.keys(limits).length) (providers[local] || (providers[local] = {}))[key] = limits;
          if (mapped) pricing[`${local}:${key}`] = mapped;
        }
      }
    }
  }

  return { models, providers, pricing };
}

async function collectEntries() {
  const { default: registry } = await import("open-sse/providers/registry/index.js");
  return registry.map(({ id }) => ({ provider: id }));
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

  const catalog = await response.json();
  const etag = response.headers.get("etag") || null;
  const entries = await collectEntries();
  const { models, providers, pricing } = build(catalog, entries);
  const payload = { v: CATALOG_VERSION, etag, syncedAt: Date.now(), models, providers, pricing };
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
    pricing: Object.keys(pricing).length,
  };
  console.log(`[modelCatalog] ${result.models} models, ${result.providers} providers, ${result.pricing} pricing, ${(result.bytes / 1024).toFixed(1)}KB`);
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
