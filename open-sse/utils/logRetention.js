// Retention for the request logs under logs/ — one directory per request, each
// holding a full copy of the request and response body. ENABLE_REQUEST_LOGS=true
// makes these grow without bound: a single Codex turn is ~230KB, so a busy day is
// already gigabytes. Pruned on the same boot path as the DB backups.
import fs from "node:fs";
import path from "node:path";

const KEEP_LOG_SESSIONS = 200;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SENSITIVE_HEADER_KEYS = [
  "authorization", "x-api-key", "api-key", "apikey", "cookie",
  "token", "bearer", "secret", "password", "credential",
];

function containsUnredactedCredential(sessionDir) {
  for (const name of ["1_req_client.json", "4_req_target.json"]) {
    const file = path.join(sessionDir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const headers = JSON.parse(fs.readFileSync(file, "utf8"))?.headers || {};
      for (const [key, value] of Object.entries(headers)) {
        if (!SENSITIVE_HEADER_KEYS.some(part => key.toLowerCase().includes(part))) continue;
        if (typeof value === "string" && value && !value.startsWith("***redacted")) return true;
      }
    } catch {
      // A corrupt debug log is handled only by regular age/count retention.
    }
  }
  return false;
}

function logsDir(cwd = process.cwd()) {
  return path.join(cwd, "logs");
}

export function pruneOldRequestLogs({ dir = logsDir(), keep = KEEP_LOG_SESSIONS, maxAgeMs = MAX_LOG_AGE_MS } = {}) {
  if (!fs.existsSync(dir)) return { removed: 0, kept: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { removed: 0, kept: 0 };
  }

  const now = Date.now();
  const stamped = entries
    .map((e) => {
      const full = path.join(dir, e.name);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  let removed = 0;
  for (const [index, entry] of stamped.entries()) {
    // Before header redaction, request logs stored live credentials. Delete those
    // sessions regardless of age; otherwise keep only recent sessions within cap.
    if (!containsUnredactedCredential(entry.full) && index < keep && now - entry.mtime < maxAgeMs) continue;
    try {
      fs.rmSync(entry.full, { recursive: true, force: true });
      removed++;
    } catch {
      // Best effort, same as pruneOldBackups: a locked dir must not break boot.
    }
  }
  return { removed, kept: stamped.length - removed };
}
