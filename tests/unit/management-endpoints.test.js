import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGEMENT_ENDPOINTS } from "@/shared/constants/managementEndpoints.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// "/api/combos/{id}" -> src/app/api/combos/[id]/route.js
// "/v1/models"       -> src/app/api/v1/models/route.js
function routeFileFor(path) {
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path;
  const dynamicPath = apiPath.replace(/\{([^}]+)\}/g, "[$1]");
  return `src/app/api${dynamicPath}/route.js`;
}

describe("MANAGEMENT_ENDPOINTS", () => {
  it.each(MANAGEMENT_ENDPOINTS)("$method $path resolves to a real route file", ({ path }) => {
    const file = routeFileFor(path);
    expect(existsSync(resolve(REPO_ROOT, file))).toBe(true);
  });
});
