import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../open-sse/executors");
const EXEMPT = path.join(DIR, "buildheaders-no-body.txt");

/**
 * The base calls `buildHeaders(credentials, stream, url, model, transformedBody)`.
 * An override that forwards to `super` without taking the body is only safe when it
 * derives nothing from it: measured on opencode-go, where the session id comes from
 * the body — dropping it made every non-passthrough request fail with the
 * transport's "MissingSessionID", surfaced as a bare 400 carrying the request body.
 *
 * A file that legitimately needs no body (it gets what it needs in transformRequest,
 * which runs first) lists itself in buildheaders-no-body.txt with the reason. Same
 * shape as the baseline allowlists elsewhere in this suite: an exception is written
 * down, not inferred.
 */
describe("executor buildHeaders overrides", () => {
  it("forwards the body, or says in writing why it does not need it", () => {
    const exempt = new Set(
      readFileSync(EXEMPT, "utf8").split("\n").map((l) => l.split("#")[0].trim()).filter(Boolean)
    );
    const offenders = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".js") && f !== "base.js")) {
      const src = readFileSync(path.join(DIR, file), "utf8");
      const m = src.match(/\n\s*buildHeaders\(([^)]*)\)\s*\{([\s\S]*?)\n  \}/);
      if (!m) continue;
      const [, params, impl] = m;
      if (!/super\.buildHeaders\(/.test(impl)) continue;
      const names = params.split(",").map((p) => p.split("=")[0].trim()).filter(Boolean);
      if (!names.includes("body") && !exempt.has(file)) offenders.push(`${file}: ${params.replace(/\s+/g, " ").trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});
