import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

// Tests get their own database, per run. Two reasons, both measured:
//
//  - Without it they open the operator's real one (~/.9router), so a test run
//    writes fixtures into live data.
//  - They also failed on it. SQLite allows one writer, the schema sets
//    `busy_timeout = 5000`, and that real file carries enough history that writes
//    under 60 parallel test files exceed it: "database is locked" surfaced as a
//    different victim each run (xai, usage-dispatch, zed), every one of them
//    passing when run alone. Against a fresh file the same suite is green.
//
// Per-run rather than a fixed path so every run starts from an empty schema.
const TEST_DATA_DIR = resolve(tmpdir(), `9router-tests-${process.pid}`);

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    env: { DATA_DIR: TEST_DATA_DIR },
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    // Files that dynamically import a heavy module graph spend most of this budget
    // on the import itself, not on the assertions: measured, unit/xai-oauth-service
    // takes ~3.2s alone against vitest's 5s default, so under parallel load (or a
    // concurrent production build) it timed out instead of failing, and the red
    // moved to another file on the next run. A file that needs more can still set
    // its own budget; this is the floor for the whole suite.
    testTimeout: 15000,
    // Restore `vi.stubGlobal` between tests. Without it a file that stubs `fetch`
    // and never unfixes leaks the stub into every other file sharing the worker,
    // and a file whose own `restoreAllMocks` removes a stub mid-test then makes a
    // REAL network call: measured, unit/xai-oauth-service.test.js and
    // unit/zed-live-models.test.js each failed in the full suite while passing
    // alone, and the victim moved between runs.
    unstubGlobals: true,
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
