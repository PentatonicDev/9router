// src/lib/localDb.js is a hand-maintained re-export shim: a function added to the
// db layer but not listed there is undefined at runtime, and a test that mocks
// "@/lib/localDb" cannot see that. This reads the real shim so a missing export
// fails here instead of in a 500 on the first chat request.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-shim-"));

let shim;
let dbLayer;

beforeAll(async () => {
  shim = await import("@/lib/localDb.js");
  dbLayer = await import("@/lib/db/index.js");
});

describe("localDb shim", () => {
  // The router imports every one of these from the shim on the chat path. A name
  // added to the db layer but not to the shim is undefined at runtime; mocking
  // "@/lib/localDb" in a route test hides exactly that.
  const ROUTER_EXPORTS = [
    "getSettings",
    "getApiKeyRoutingContext",
    "getApiKeyOwner",
    "getProviderConnections",
    "updateProviderConnection",
  ];

  it("exposes what the chat path imports from it", () => {
    const missing = ROUTER_EXPORTS.filter((name) => typeof shim[name] !== "function");
    expect(missing).toEqual([]);
  });

  // Every name above must also exist in the db layer, so this list cannot drift
  // into asserting something the shim re-exports from nowhere.
  it("only lists names the db layer actually provides", () => {
    const absent = ROUTER_EXPORTS.filter((name) => !(name in dbLayer));
    expect(absent).toEqual([]);
  });
});
