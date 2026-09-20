// Node module customization hook (see register-loader.mjs) that teaches plain
// `node` the "@/" -> "src/" and "open-sse" -> "open-sse/" aliases vitest.config.js
// resolves for the test suite, so fixtures spawned as real child processes
// (tests/unit/leases-two-process.test.js) can import production code unmodified.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Bundler-style resolvers (webpack/vitest) resolve an extensionless deep
// import like "@/lib/auth/resourceScope"; plain Node ESM doesn't. Some
// production files rely on that (jsconfig.json's `@/*` alias makes it look
// bundler-resolved everywhere), so retry with ".js" appended before giving up.
async function resolveWithJsFallback(url, context, nextResolve) {
  if (path.extname(url) !== "") return nextResolve(url, context);
  try {
    return await nextResolve(url, context);
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return nextResolve(`${url}.js`, context);
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = path.join(ROOT, "src", specifier.slice(2));
    return resolveWithJsFallback(pathToFileURL(target).href, context, nextResolve);
  }
  if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    const rest = specifier.slice("open-sse".length).replace(/^\//, "");
    const target = path.join(ROOT, "open-sse", rest);
    return resolveWithJsFallback(pathToFileURL(target).href, context, nextResolve);
  }
  return nextResolve(specifier, context);
}

// node-machine-id's published bundle is a deeply-nested UMD factory
// (`module.exports = factory(...)`, with `machineIdSync`/`machineId` assigned
// on a local var several closures in) — Node's cjs-module-lexer named-export
// detection needs `exports.x = …`/`module.exports.x = …` at the top level and
// doesn't see through that, so plain ESM `import { machineIdSync } from
// "node-machine-id"` throws even though the package works fine. Bundlers
// (webpack/Vite, i.e. the actual app and vitest) use full CJS interop instead
// and never hit this — it only bites a real `node` process running production
// code unmodified, which is exactly what these fixtures do. Reload it through
// createRequire and re-export by hand.
export async function load(url, context, nextLoad) {
  if (/\/node-machine-id\/dist\/index\.js$/.test(url)) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        import { createRequire } from "node:module";
        const mod = createRequire(${JSON.stringify(import.meta.url)})(${JSON.stringify(fileURLToPath(url))});
        export const machineIdSync = mod.machineIdSync;
        export const machineId = mod.machineId;
        export default mod;
      `,
    };
  }
  return nextLoad(url, context);
}
