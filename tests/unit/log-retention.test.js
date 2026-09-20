import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneOldRequestLogs } from "../../open-sse/utils/logRetention.js";

const roots = [];
const DAY = 24 * 60 * 60 * 1000;

function makeDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-log-retention-"));
  roots.push(root);
  return root;
}

function session(root, name, ageMs) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "1_req_client.json"), "{}");
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, at, at);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("request log retention", () => {
  it("deletes expired sessions even below the count cap", () => {
    const root = makeDir();
    session(root, "recent", DAY);
    session(root, "expired", 8 * DAY);

    expect(pruneOldRequestLogs({ dir: root, keep: 200, maxAgeMs: 7 * DAY })).toEqual({ removed: 1, kept: 1 });
    expect(fs.readdirSync(root)).toEqual(["recent"]);
  });


  it("deletes legacy sessions with unredacted credentials regardless of age", () => {
    const root = makeDir();
    session(root, "safe", DAY);
    session(root, "unsafe", DAY);
    fs.writeFileSync(path.join(root, "safe", "4_req_target.json"), JSON.stringify({
      headers: { Authorization: "***redacted(len=42)", "Content-Type": "application/json" },
    }));
    fs.writeFileSync(path.join(root, "unsafe", "4_req_target.json"), JSON.stringify({
      headers: { Authorization: "Bearer live-token-value" },
    }));

    expect(pruneOldRequestLogs({ dir: root, keep: 200, maxAgeMs: 7 * DAY })).toEqual({ removed: 1, kept: 1 });
    expect(fs.readdirSync(root)).toEqual(["safe"]);
  });

  it("caps recent sessions by newest mtime", () => {
    const root = makeDir();
    for (let i = 0; i < 5; i++) session(root, `s${i}`, i * 1000);

    expect(pruneOldRequestLogs({ dir: root, keep: 2, maxAgeMs: 7 * DAY })).toEqual({ removed: 3, kept: 2 });
    expect(fs.readdirSync(root).sort()).toEqual(["s0", "s1"]);
  });

  it("ignores files and missing directories", () => {
    const root = makeDir();
    fs.writeFileSync(path.join(root, "README"), "not a session");

    expect(pruneOldRequestLogs({ dir: root })).toEqual({ removed: 0, kept: 0 });
    expect(pruneOldRequestLogs({ dir: path.join(root, "missing") })).toEqual({ removed: 0, kept: 0 });
  });
});
