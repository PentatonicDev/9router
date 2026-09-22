import { describe, expect, it } from "vitest";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

/**
 * Four providers declare `modelsFetcher.type: "openai"` and the filter never existed,
 * so the route answered 400 "Unknown filter type" and their model lists came back
 * empty. The set of declared types and the set of implemented filters have to agree.
 */
describe("suggested-models filters", () => {
  it("implements every type the registry declares", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../../open-sse/providers/registry");
    const declared = new Set();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/modelsFetcher:\s*\{[^}]*?type:\s*"([a-z-]+)"/g)) declared.add(m[1]);
    }
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].filter((t) => !FILTERS[t])).toEqual([]);
  });

  it("keeps only free language models with ≥200k context", () => {
    const free200k = { id: "a/b", name: "AB", context_window: 256000, type: "language", pricing: { input: "0", output: "0" } };
    const paid = { id: "c/d", name: "CD", context_window: 256000, type: "language", pricing: { input: "0.003", output: "0.015" } };
    const small = { id: "e/f", context_window: 128000, type: "language", pricing: { input: "0", output: "0" } };
    const embedding = { id: "g/h", context_window: 256000, type: "embedding", pricing: { input: "0", output: "0" } };
    const noType = { id: "i/j", context_window: 256000, pricing: { input: "0", output: "0" } };
    const rows = [free200k, paid, small, embedding, noType];
    const result = FILTERS.openai(rows);
    expect(result).toEqual([
      { id: "a/b", name: "AB", contextLength: 256000 },
      { id: "i/j", name: "i/j", contextLength: 256000 },
    ]);
    expect(FILTERS.openai({ data: rows })).toHaveLength(2);
    expect(FILTERS.openai([{ no: "id" }])).toEqual([]);
    expect(FILTERS.openai(null)).toEqual([]);
  });
});
