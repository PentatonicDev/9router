import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  // Off: every resource stays visible to anyone who can log in (legacy behaviour).
  // Turning it off later never drops ownership, it only stops enforcing it.
  scopeResourcesByUser: false,
  // E-mails that act as admin when password login is unavailable (SSO-only).
  ssoAdminEmails: [],
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:9router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  // Route each API key's traffic to its own Headroom project (/p/<key name>),
  // so per-project stats separate the callers instead of pooling them.
  headroomPerApiKeyProject: false,
  // Per-user token-saver overrides, keyed by owner. A key left unset here keeps
  // the global (admin) value, so the default lives in one place.
  tokenSaverByOwner: {},
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // Gateway-side emulation of Anthropic's web_search server tool for upstreams
  // that can't run it natively (Bedrock, etc). Empty source = auto-pick.
  webSearchSource: "",
  webSearchEmulation: true,
  // Admin-configured SearXNG base URL. Empty = SEARXNG_URL env / registry default.
  searxngUrl: "",
  // System One decision routing. `mode` is one field with three states rather
  // than an `enabled` flag plus a mode string: "off" never asks, "shadow" asks
  // and logs but applies nothing (the baseline needed to measure before
  // trusting), "enforce" applies. `models` is the allowlist — model strings
  // and/or combo names, empty meaning nothing routes — and `briefs` holds the
  // operator's own "what this model is FOR" text per model, which is what makes
  // the decision accurate; the repo table is only the default.
  decisionRouter: {
    mode: "off",
    // The gateway that serves the decision model. It IS the provider — a decision
    // route borrows that gateway's credential, so there is no separate provider
    // identity to configure, and swapping to a better System-1 model is editing
    // `model` and nothing else.
    provider: "vercel-ai-gateway",
    model: "typesafe-ai/jev",
    models: [],
    briefs: {},
    toolMode: "hint",
    minConfidence: 0.7,
    switchConfidence: 0.85,
    // Matches STREAM_STATUS_GRACE_MS: within it the request is answered before the
    // SSE has to open, so a slow decision costs latency but not a broken stream.
    // The steady state is ~350ms; the tail is what this budget is for.
    timeoutMs: 1500,
  },
};

async function readRaw() {
  const db = await getDb();
  const row = await db.selectFrom("settings").select("data").where("id", "=", 1).executeTakeFirst();
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getDb();
  let next;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("settings").select("data").where("id", "=", 1).executeTakeFirst();
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    const data = stringifyJson(next);
    await trx.insertInto("settings")
      .values({ id: 1, data })
      .onConflict((oc) => oc.column("id").doUpdateSet({ data }))
      .execute();
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
