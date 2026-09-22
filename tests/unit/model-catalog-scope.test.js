import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Both modules read their file path from DATA_DIR at import time, so the temp
// data dir has to be in place before the first import.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-catalog-"));
process.env.DATA_DIR = dataDir;
const catalogFile = path.join(dataDir, "model-catalog.json");

// One upstream record per gateway: the same short id means different things to
// different vendors, which is what used to leak capabilities across providers.
const upstream = {
  zai: { models: { "glm-4.6v": { modalities: { input: ["text", "image"] } } } },
  zhipuai: { models: { "glm-5-canary": { modalities: { input: ["text", "image", "pdf"] } } } },
  moonshotai: { models: { "kimi-k3": { modalities: { input: ["text"] } } } },
  kilo: { models: { "kilo-auto/efficient": { modalities: { input: ["text", "image"] } } } },
  openrouter: { models: {
    "openai/gpt-6-sol": { modalities: { input: ["text", "image"] }, reasoning: true, tool_call: true, limit: { context: 1050000, output: 128000 }, cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, tiers: [{ tier: { type: "context", size: 272000 }, input: 4, output: 15 }] } },
    "openai/gpt-6-sol:free": { modalities: { input: ["text"] }, reasoning: false, tool_call: false, limit: { context: 32000, output: 4000 }, cost: { input: 0, output: 0 } },
    "other/gpt-6-sol": { modalities: { input: ["text", "audio"] }, cost: { input: 3, output: 12 } },
  } },
};
// The registry snapshot the sync feeds build(): local ids, with the capabilities
// the tables resolve on their own.
const entries = ["glm", "glm-cn", "zhipu", "kimi", "openrouter"].map((provider) => ({ provider }));
const visionCaps = {
  vision: true,
  pdf: false,
  audioInput: false,
  videoInput: false,
  imageOutput: false,
  audioOutput: false,
  reasoning: false,
  tools: true,
};
const visionPdfCaps = { ...visionCaps, pdf: true };
const textCaps = { ...visionCaps, vision: false };

let build, getCatalogModalities, getCatalogPricing, invalidateCatalog, syncModelCatalog, startModelCatalogSync, capabilities;

beforeAll(async () => {
  ({ build, syncModelCatalog, startModelCatalogSync } = await import("../../src/lib/modelCatalog/sync.js"));
  // the builder is exercised directly; a missing export must fail loudly here
  // rather than skip every case below
  expect(typeof build).toBe("function");
  const { models, providers, pricing } = build(upstream, entries);
  fs.writeFileSync(catalogFile, JSON.stringify({ v: 4, models, providers, pricing }));
  ({ getCatalogModalities, getCatalogPricing, invalidateCatalog } = await import("../../open-sse/providers/catalogOverride.js"));
  capabilities = await import("../../open-sse/providers/capabilities.js");
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("model catalog", () => {
  it("keys modalities by gateway and writes no model-only key", () => {
    const { models } = build(upstream, entries);
    // upstream "zai" is filed under the local id requests arrive with...
    expect(models["glm:glm-4.6v"]).toEqual(visionCaps);
    // ...and under its upstream name, because a custom provider node can carry
    // that name without being in the registry snapshot
    expect(models["zai:glm-4.6v"]).toEqual(visionCaps);
    expect(models["kilo:efficient"]).toEqual(visionCaps);
    expect(models["kilo:kilo-auto/efficient"]).toEqual(visionCaps);
    // the vendor-stripped key is what used to be shared with every other gateway
    expect(models["glm-4.6v"]).toBeUndefined();
    expect(models["efficient"]).toBeUndefined();
    // Text-only declarations stay explicit so catalog can turn a pattern false.
    expect(models["kimi:kimi-k3"]).toEqual(textCaps);
  });

  it("files an upstream provider under every local id that aliases it", () => {
    const { models } = build(upstream, entries);
    // glm-cn and zhipu are both zhipuai upstream; neither may be dropped
    expect(models["glm-cn:glm-5-canary"]).toEqual(visionPdfCaps);
    expect(models["zhipu:glm-5-canary"]).toEqual(visionPdfCaps);
    expect(models["zhipuai:glm-5-canary"]).toEqual(visionPdfCaps);
    expect(getCatalogModalities("glm-cn", "glm-5-canary")).toEqual(visionPdfCaps);
    expect(getCatalogModalities("zhipu", "glm-5-canary")).toEqual(visionPdfCaps);
  });

  it("does not hand a router mode another vendor's modalities", () => {
    // kilo's "efficient" is a real model; another gateway's "efficient" is a mode
    expect(getCatalogModalities("kilo", "kilo-auto/efficient")).toEqual(visionCaps);
    expect(getCatalogModalities("kilo-gateway", "openai/gpt-6-sol")).toBeNull();
    expect(getCatalogModalities("qoder", "efficient")).toBeNull();
  });

  it("resolves a gateway the file was written for, and nobody else", () => {
    expect(getCatalogModalities("glm", "glm-4.6v")).toEqual(visionCaps);
    expect(getCatalogModalities("zai", "glm-4.6v")).toEqual(visionCaps);
    expect(getCatalogModalities("unrelated", "glm-4.6v")).toBeNull();
    expect(getCatalogModalities(undefined, "glm-4.6v")).toBeNull();
  });

  it("preserves exact vendor and variant IDs across capabilities, limits and prices", () => {
    const { models, providers, pricing } = build(upstream, entries);
    expect(models["openrouter:openai/gpt-6-sol"]).toMatchObject({ vision: true, reasoning: true, tools: true });
    expect(models["openrouter:openai/gpt-6-sol:free"]).toMatchObject({ vision: false, reasoning: false, tools: false });
    expect(models["openrouter:other/gpt-6-sol"]).toMatchObject({ audioInput: true });
    expect(models["openrouter:gpt-6-sol"]).toBeUndefined();
    expect(providers.openrouter["openai/gpt-6-sol"]).toEqual({ contextWindow: 1050000, maxOutput: 128000 });
    expect(providers.openrouter["openai/gpt-6-sol:free"]).toEqual({ contextWindow: 32000, maxOutput: 4000 });
    expect(pricing["openrouter:openai/gpt-6-sol"].tiers[0].tier.size).toBe(272000);
    expect(pricing["openrouter:openai/gpt-6-sol:free"].input).toBe(0);
    expect(pricing["openrouter:other/gpt-6-sol"].input).toBe(3);
    expect(getCatalogPricing("openrouter", "openai/gpt-6-sol:free")?.input).toBe(0);
    expect(getCatalogPricing("openrouter", "openai/gpt-6-sol:unknown")).toBeNull();
  });

  it("lets catalog override exact tables and heuristics without losing manual wire settings", () => {
    const source = {
      getModalities: (provider, model) => provider === "openai" && model === "gpt-6-astra"
        ? { vision: false, reasoning: false, tools: false } : null,
      getLimits: () => ({ contextWindow: 8192, maxOutput: 2048 }),
    };
    capabilities.setCatalogSource(source);
    try {
      expect(capabilities.getCapabilitiesForModel("openai", "gpt-6-astra")).toMatchObject({
        vision: false, reasoning: false, tools: false, contextWindow: 8192,
        maxOutput: 2048, thinkingFormat: "openai", search: true,
      });
    } finally {
      capabilities.setCatalogSource(null);
    }
  });

  it("passes the gateway to the catalog reader when refining", () => {
    const seen = [];
    capabilities.setCatalogSource({
      getModalities: (provider) => {
        seen.push(provider);
        return provider === "gateway-a" ? { vision: true } : null;
      },
      getLimits: () => null,
    });
    try {
      // "*laguna*" resolves from the pattern table, so refine() runs
      expect(capabilities.getCapabilitiesForModel("gateway-a", "laguna-9-preview").vision).toBe(true);
      expect(capabilities.getCapabilitiesForModel("gateway-b", "laguna-9-preview").vision).toBe(false);
      expect(seen).toContain("gateway-a");
    } finally {
      capabilities.setCatalogSource(null);
    }
  });

  it("shares the installed source with every copy of the module", async () => {
    const source = {
      getModalities: (provider) => (provider === "gateway-a" ? { vision: true } : null),
      getLimits: () => null,
    };
    capabilities.setCatalogSource(source);
    try {
      // The server bundles this module into more than one chunk and the startup
      // hook only runs in one of them, so the slot has to be process-wide.
      expect(globalThis.__9rCatalogSource).toBe(source);
      const other = await import("../../open-sse/providers/capabilities.js?copy=2");
      expect(other.getCapabilitiesForModel).not.toBe(capabilities.getCapabilitiesForModel);
      // ...and that second copy resolves through the source it never installed
      expect(other.getCapabilitiesForModel("gateway-a", "laguna-9-preview").vision).toBe(true);
    } finally {
      capabilities.setCatalogSource(null);
    }
    expect(globalThis.__9rCatalogSource).toBeNull();
  });
});

describe("catalog schema", () => {
  it("ignores a file written before the keys were scoped", () => {
    const scoped = fs.readFileSync(catalogFile);
    // v1: flat model keys, which is exactly the shape that collided
    fs.writeFileSync(catalogFile, JSON.stringify({ v: 1, models: { "kimi-k3": { vision: true } }, providers: {} }));
    invalidateCatalog();
    expect(getCatalogModalities("kimi", "kimi-k3")).toBeNull();
    fs.writeFileSync(catalogFile, scoped);
    invalidateCatalog();
  });

  it("rebuilds an older-schema file instead of trusting its etag", async () => {
    fs.writeFileSync(catalogFile, JSON.stringify({ v: 1, etag: 'W/"old"', models: {}, providers: {} }));
    invalidateCatalog();
    startModelCatalogSync();   // picks the file's etag + schema version back up

    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      sent.push(options?.headers || {});
      return { ok: true, status: 200, headers: new Map([["etag", 'W/"new"']]), json: async () => upstream };
    };
    try {
      expect((await syncModelCatalog()).status).toBe("updated");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent[0]["if-none-match"]).toBeUndefined();
    const written = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    expect(written.v).toBe(4);
    expect(written.models["glm:glm-4.6v"]).toEqual(visionCaps);
  });

  it("asks upstream for a 304 once the file is current", async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      sent.push(options?.headers || {});
      return { ok: false, status: 304, headers: new Map(), json: async () => ({}) };
    };
    try {
      expect((await syncModelCatalog()).status).toBe("unchanged");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent[0]["if-none-match"]).toBe('W/"new"');
  });
});
