import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-logger-retention-"));
const logs = path.join(root, "logs");
const originalCwd = process.cwd();

process.env.ENABLE_REQUEST_LOGS = "true";
process.chdir(root);

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("request logger retention", () => {
  it("prunes expired sessions while running, not only at boot", async () => {
    const expired = path.join(logs, "expired");
    fs.mkdirSync(expired, { recursive: true });
    const old = new Date(Date.now() - 8 * DAY);
    fs.utimesSync(expired, old, old);

    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const logger = await createRequestLogger("openai", "claude", "m");

    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(logger.sessionPath)).toBe(true);

    fs.mkdirSync(expired);
    fs.utimesSync(expired, old, old);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(now + 60_000);
      await createRequestLogger("openai", "claude", "before-interval");
      expect(fs.existsSync(expired)).toBe(true);

      clock.mockReturnValue(now + 10 * 60_000);
      const next = await createRequestLogger("openai", "claude", "after-interval");
      expect(fs.existsSync(expired)).toBe(false);
      expect(fs.existsSync(next.sessionPath)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});
