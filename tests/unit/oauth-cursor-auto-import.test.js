import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import { execFile } from "child_process";
import { homedir } from "os";
import { mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import RealDatabase from "better-sqlite3";

// The route used to be macOS-only for multi-path probing, per-open-error
// text and a fuzzy key-name fallback (added in d7e06c30). That behavior was
// torn out across fd4ec9e5 / 3f852775 / a6c764d7: every platform now probes
// a candidate-path list, token extraction only tries exact key names
// (better-sqlite3 first, then the sqlite3 CLI), and any failure short of
// "no candidate path exists" collapses into the generic windowsManual
// fallback rather than a distinct error message.

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Mock child_process — route calls promisify(execFile) at module load time,
// so the mock must expose the same custom-promisify hook Node's real
// execFile uses; otherwise promisify() would wrap our mock in its generic
// callback adapter and never see it as already-async.
vi.mock("child_process", () => {
  const fn = vi.fn();
  fn[Symbol.for("nodejs.util.promisify.custom")] = (...args) => fn(...args);
  return { execFile: fn };
});

// better-sqlite3 is intentionally NOT mocked: the route loads it via a
// dynamic `require("better-sqlite3")` inside a CJS-style helper, which vitest's
// module mocking (built for `import`/vite-node's SSR graph) does not intercept
// — verified by instrumenting the route, a mocked `require` here is silently
// bypassed and the real native module runs regardless. Tests that need the
// better-sqlite3 strategy to succeed build a real, throwaway SQLite fixture
// with the real driver instead of pretending to mock it.
const fixtureHomes = [];

function makeFixtureDb(relPath, rows) {
  const home = join("/tmp", `9router-cursor-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fixtureHomes.push(home);
  const dbPath = join(home, relPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new RealDatabase(dbPath);
  db.exec("CREATE TABLE itemTable (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO itemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
  return { home, dbPath };
}

const HOME = "/mock/home";
const DARWIN_PATHS = [
  `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
  `${HOME}/Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb`,
];
const DEFAULT_PATHS = [
  `${HOME}/.config/Cursor/User/globalStorage/state.vscdb`,
  `${HOME}/.config/cursor/User/globalStorage/state.vscdb`,
];

function mockAccessResolvingOnly(paths) {
  vi.mocked(fsPromises.access).mockImplementation((path) =>
    paths.includes(path) ? Promise.resolve() : Promise.reject(new Error("ENOENT")),
  );
}

// We need to dynamically import after mocks are registered
let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue(HOME);
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(execFile).mockRejectedValue(new Error("ENOENT: command not found"));
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    while (fixtureHomes.length) {
      rmSync(fixtureHomes.pop(), { recursive: true, force: true });
    }
  });

  // ── Path probing per platform ─────────────────────────────────────────

  it("darwin: probes the standard and Insiders db locations", async () => {
    await GET();

    for (const path of DARWIN_PATHS) {
      expect(fsPromises.access).toHaveBeenCalledWith(path, 4);
    }
  });

  it("win32: probes APPDATA/LOCALAPPDATA and the Programs install location", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const savedAppData = process.env.APPDATA;
    const savedLocalAppData = process.env.LOCALAPPDATA;
    process.env.APPDATA = "/mock/appdata";
    process.env.LOCALAPPDATA = "/mock/localappdata";

    try {
      await GET();

      expect(fsPromises.access).toHaveBeenCalledWith("/mock/appdata/Cursor/User/globalStorage/state.vscdb", 4);
      expect(fsPromises.access).toHaveBeenCalledWith(
        "/mock/appdata/Cursor - Insiders/User/globalStorage/state.vscdb",
        4,
      );
      expect(fsPromises.access).toHaveBeenCalledWith("/mock/localappdata/Cursor/User/globalStorage/state.vscdb", 4);
      expect(fsPromises.access).toHaveBeenCalledWith(
        "/mock/localappdata/Programs/Cursor/User/globalStorage/state.vscdb",
        4,
      );
    } finally {
      process.env.APPDATA = savedAppData;
      process.env.LOCALAPPDATA = savedLocalAppData;
    }
  });

  it("linux: probes the lowercase and capitalized config dirs", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    await GET();

    for (const path of DEFAULT_PATHS) {
      expect(fsPromises.access).toHaveBeenCalledWith(path, 4);
    }
  });

  // ── Not-found message ─────────────────────────────────────────────────

  it("returns not-found listing every checked location when no candidate path is accessible", async () => {
    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toBe(
      `Cursor database not found. Checked locations:\n${DARWIN_PATHS.join("\n")}\n\nMake sure Cursor IDE is installed and opened at least once.`,
    );
  });

  // ── Token extraction (exact keys only — no fuzzy fallback anymore) ────

  const DARWIN_DB_RELPATH = "Library/Application Support/Cursor/User/globalStorage/state.vscdb";

  it("extracts tokens via better-sqlite3 using the primary key names", async () => {
    const { home, dbPath } = makeFixtureDb(DARWIN_DB_RELPATH, {
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });
    vi.mocked(homedir).mockReturnValue(home);
    mockAccessResolvingOnly([dbPath]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
  });

  it("falls through to the secondary key name when the primary one is absent", async () => {
    const { home, dbPath } = makeFixtureDb(DARWIN_DB_RELPATH, {
      "cursorAuth/token": "secondary-token",
      "storage.machineId": "secondary-machine-id",
    });
    vi.mocked(homedir).mockReturnValue(home);
    mockAccessResolvingOnly([dbPath]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("secondary-token");
    expect(response.body.machineId).toBe("secondary-machine-id");
  });

  it("unwraps JSON-encoded string values", async () => {
    const { home, dbPath } = makeFixtureDb(DARWIN_DB_RELPATH, {
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });
    vi.mocked(homedir).mockReturnValue(home);
    mockAccessResolvingOnly([dbPath]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  // ── Cascade: better-sqlite3 -> sqlite3 CLI -> windowsManual ───────────

  it("falls through to the sqlite3 CLI when better-sqlite3 cannot open the database", async () => {
    // No real file backs this candidate path, so `new Database(..., { fileMustExist: true })`
    // throws for real and the route must fall through to the CLI strategy.
    mockAccessResolvingOnly(DARWIN_PATHS);
    vi.mocked(execFile).mockImplementation((cmd, args) => {
      if (cmd !== "sqlite3") return Promise.reject(new Error("ENOENT"));
      const key = args[1].match(/key='([^']+)'/)?.[1];
      const rows = {
        "cursorAuth/accessToken": "cli-token",
        "storage.serviceMachineId": "cli-machine-id",
      };
      return rows[key] ? Promise.resolve({ stdout: `${rows[key]}\n`, stderr: "" }) : Promise.reject(new Error("no rows"));
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("cli-token");
    expect(response.body.machineId).toBe("cli-machine-id");
  });

  it("falls back to windowsManual when both better-sqlite3 and the sqlite3 CLI find no tokens", async () => {
    // No real file backs this candidate path (better-sqlite3 throws) and the
    // default execFile mock (from beforeEach) rejects every CLI call too.
    mockAccessResolvingOnly(DARWIN_PATHS);

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toBe(DARWIN_PATHS[0]);
  });

  // ── Linux install check (only runs once a db candidate is found) ──────

  const LINUX_DB_RELPATH = ".config/Cursor/User/globalStorage/state.vscdb";

  it("linux: proceeds when `which cursor` confirms the IDE is installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const { home, dbPath } = makeFixtureDb(LINUX_DB_RELPATH, {
      "cursorAuth/accessToken": "tok",
      "storage.serviceMachineId": "mid",
    });
    vi.mocked(homedir).mockReturnValue(home);
    mockAccessResolvingOnly([dbPath]);
    vi.mocked(execFile).mockImplementation((cmd) =>
      cmd === "which" ? Promise.resolve({ stdout: "/usr/bin/cursor\n", stderr: "" }) : Promise.reject(new Error("ENOENT")),
    );

    const response = await GET();

    expect(response.body.found).toBe(true);
  });

  it("linux: falls back to the .desktop file when `which cursor` fails", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const { home, dbPath } = makeFixtureDb(LINUX_DB_RELPATH, {
      "cursorAuth/accessToken": "tok",
      "storage.serviceMachineId": "mid",
    });
    const desktopFile = join(home, ".local/share/applications/cursor.desktop");
    vi.mocked(homedir).mockReturnValue(home);
    mockAccessResolvingOnly([dbPath, desktopFile]);

    const response = await GET();

    expect(response.body.found).toBe(true);
  });

  it("linux: skips auto-import when Cursor is not actually installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    mockAccessResolvingOnly(DEFAULT_PATHS);
    // `which cursor` and the .desktop check both fail (default execFile/access mocks)

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toBe(
      "Cursor config files found but Cursor IDE does not appear to be installed. Skipping auto-import.",
    );
  });

  // ── No hard rejection for unrecognized platforms ───────────────────────

  it("unrecognized platform falls back to the default config-dir paths instead of a 400", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(DEFAULT_PATHS[0]);
    expect(response.body.error).toContain(DEFAULT_PATHS[1]);
    // the linux-only install check must not run for a platform that merely
    // shares its default path list
    expect(execFile).not.toHaveBeenCalled();
  });
});
