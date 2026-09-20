export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Cross-process OAuth refresh coordination (see src/lib/db/refreshCoordinator.js).
    const { setRefreshCoordinator } = await import("open-sse/services/oauthCredentialManager.js");
    const { createDbRefreshCoordinator } = await import("@/lib/db/refreshCoordinator.js");
    setRefreshCoordinator(createDbRefreshCoordinator());

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Runs on server boot, not on first dashboard render: /v1 traffic alone never
    // loads layout.js, so OAuth tokens would only refresh once someone opened the UI.
    const { startBackgroundTokenRefresh } = await import("@/sse/services/backgroundTokenRefresh.js");
    startBackgroundTokenRefresh();

    // Same reasoning as backgroundTokenRefresh above: these were previously started
    // from initializeApp.js's dashboard-triggered path, which never runs for /v1-only
    // traffic. Moved to boot so quota auto-ping and quota unlock always run.
    const { getSettings } = await import("@/lib/localDb");
    const { configureQuotaAutoPing } = await import("@/shared/services/quotaAutoPing.js");
    configureQuotaAutoPing(await getSettings());

    const { startQuotaUnlock } = await import("@/shared/services/quotaUnlock.js");
    startQuotaUnlock();
  }
}
