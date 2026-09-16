import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-binding-lifecycle-"));

let keysRepo;
let connRepo;

async function makeConnection(name) {
  return connRepo.createProviderConnection({ provider: "claude", authType: "oauth", name, apiKey: `k-${name}` });
}

beforeAll(async () => {
  keysRepo = await import("@/lib/db/repos/apiKeysRepo.js");
  connRepo = await import("@/lib/db/repos/connectionsRepo.js");
});

describe("binding lifecycle", () => {
  it("a new account does not join keys that are already restricted", async () => {
    const a = await makeConnection("acc-a");
    const restricted = await keysRepo.createApiKey("restricted", "m1");
    const openKey = await keysRepo.createApiKey("open", "m1");
    await keysRepo.updateApiKey(restricted.id, { allowedConnectionIds: [a.id] });

    const b = await makeConnection("acc-b");

    // Restricted key still sees only the account it was bound to...
    expect(await keysRepo.getApiKeyAllowedConnectionIds(restricted.key)).toEqual([a.id]);
    expect(await keysRepo.getApiKeyAllowedConnectionIds(restricted.key)).not.toContain(b.id);
    // ...while an unbound key stays unrestricted (null = every account).
    expect(await keysRepo.getApiKeyAllowedConnectionIds(openKey.key)).toBeNull();
  });

  it("deleting an account drops it from every binding", async () => {
    const a = await makeConnection("del-a");
    const b = await makeConnection("del-b");
    const key = await keysRepo.createApiKey("two-accounts", "m1");
    await keysRepo.updateApiKey(key.id, { allowedConnectionIds: [a.id, b.id] });

    expect(await connRepo.deleteProviderConnection(a.id)).toBe(true);

    expect(await keysRepo.getApiKeyAllowedConnectionIds(key.key)).toEqual([b.id]);
  });

  // Emptying the list returns the key to unrestricted — the documented
  // "no bindings = every account" rule, not a lockout.
  it("removing the last bound account leaves the key unrestricted", async () => {
    const only = await makeConnection("solo");
    const key = await keysRepo.createApiKey("solo-key", "m1");
    await keysRepo.updateApiKey(key.id, { allowedConnectionIds: [only.id] });

    await connRepo.deleteProviderConnection(only.id);

    expect(await keysRepo.getApiKeyAllowedConnectionIds(key.key)).toBeNull();
  });

  it("deleting a whole provider unbinds all of its accounts", async () => {
    const a = await makeConnection("bulk-a");
    const b = await makeConnection("bulk-b");
    const key = await keysRepo.createApiKey("bulk-key", "m1");
    await keysRepo.updateApiKey(key.id, { allowedConnectionIds: [a.id, b.id] });

    const removed = await connRepo.deleteProviderConnectionsByProvider("claude");

    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await keysRepo.getApiKeyAllowedConnectionIds(key.key)).toBeNull();
  });
});
