// A certificate error must fail closed: silently retrying without verification
// would send provider credentials to whoever presented the bad cert. The
// insecure retry exists only behind ALLOW_INSECURE_TLS_FALLBACK.
import https from "node:https";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

let server;
let url;
let dir;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"),
    "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  server = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) },
    (req, res) => { res.end(req.headers.authorization || "none"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `https://127.0.0.1:${server.address().port}/`;
});

afterAll(() => {
  server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ALLOW_INSECURE_TLS_FALLBACK;
});

describe("proxyAwareFetch on a self-signed upstream", () => {
  it("refuses by default and never delivers the credential", async () => {
    delete process.env.ALLOW_INSECURE_TLS_FALLBACK;
    await expect(proxyAwareFetch(url, { headers: { Authorization: "Bearer secret" } })).rejects.toThrow();
  });

  it("retries insecurely only when explicitly allowed", async () => {
    process.env.ALLOW_INSECURE_TLS_FALLBACK = "1";
    const res = await proxyAwareFetch(url, { headers: { Authorization: "Bearer secret" } });
    expect(await res.text()).toBe("Bearer secret");
  });
});
