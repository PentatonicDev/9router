// The dashboard colours each console line by its level. The previous detector
// took match[1] from every bracket token; real lines start with a timestamp or
// request tag, so every ERROR/WARN fell through to the LOG colour.
import { afterAll, describe, expect, it } from "vitest";
import { detectConsoleLogLevel } from "@/shared/utils/consoleLogLevel.js";
import {
  clearConsoleLogs,
  getConsoleLogs,
  initConsoleLogCapture,
} from "@/lib/consoleLogBuffer.js";

// console methods are globally patched by this module. Keep the originals so this
// test cannot leak the patch into other files when Vitest reuses a worker.
const originals = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

initConsoleLogCapture();

afterAll(() => {
  Object.assign(console, originals);
});

describe("console log level detection", () => {
  it("reads the real logger prefixes", () => {
    expect(detectConsoleLogLevel("[12:00:00] ❌ [AUTH] refresh failed")).toBe("ERROR");
    expect(detectConsoleLogLevel("[12:00:00] ⚠️  [AUTH] expiring soon")).toBe("WARN");
    expect(detectConsoleLogLevel("[12:00:00] ℹ️  [CHAT] routed")).toBe("INFO");
    expect(detectConsoleLogLevel("[12:00:00] 🔍 [CHAT] detail")).toBe("DEBUG");
  });

  it("does not mistake a timestamp or a request tag for the level", () => {
    expect(detectConsoleLogLevel("[12:00:00] [AUTH] something happened")).toBe("LOG");
    expect(detectConsoleLogLevel("[12:00:00] ❌ something failed")).toBe("ERROR");
    expect(detectConsoleLogLevel("[12:00:00] ⚠️  something odd")).toBe("WARN");
  });

  it("defaults to LOG when no level is present", () => {
    expect(detectConsoleLogLevel("plain line with no marker")).toBe("LOG");
    expect(detectConsoleLogLevel("")).toBe("LOG");
  });

  it("preserves raw console method levels in the buffer", () => {
    clearConsoleLogs();
    console.error("failure");
    console.warn("warning");
    console.info("information");
    console.debug("detail");
    console.log("plain");

    expect(getConsoleLogs()).toEqual([
      "[ERROR] failure",
      "[WARN] warning",
      "[INFO] information",
      "[DEBUG] detail",
      "plain",
    ]);
    expect(getConsoleLogs().map(detectConsoleLogLevel))
      .toEqual(["ERROR", "WARN", "INFO", "DEBUG", "LOG"]);
  });
});
