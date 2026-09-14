export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Runs on server boot, not on first dashboard render: /v1 traffic alone never
    // loads layout.js, so OAuth tokens would only refresh once someone opened the UI.
    const { startBackgroundTokenRefresh } = await import("@/sse/services/backgroundTokenRefresh.js");
    startBackgroundTokenRefresh();
  }
}
