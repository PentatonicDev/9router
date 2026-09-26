import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getExhaustedQuotaResetMs } from "../services/quotaReset.js";
import { getSettings, getApiKeyRoutingContext } from "@/lib/localDb";
import { resolveScopedSettings, headroomProjectUrl } from "@/lib/auth/scopedSettings";
import { getModelInfo, getComboModels, getComboModelOptions } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { createErrorContext, errorResponse, responseFromRoutingCandidate, withRequestId } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint, FORMATS } from "open-sse/translator/formats.js";
import { createStreamingResponse } from "open-sse/utils/streamHandler.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { adminKeyRefusal } from "../utils/adminKeyGuard.js";
import { THINKING_ORDER } from "open-sse/translator/concerns/thinking.js";
import { hasWebSearchServerTool, emulateWebSearch } from "../services/webSearchEmulation.js";

// Effective thinking cap for one candidate = the tighter (lower THINKING_ORDER
// position) of the combo-wide cap and that candidate's own per-model cap;
// either may be absent. A level absent from THINKING_ORDER is ignored, same
// as applyThinking's own unknown-cap handling.
export function resolveMaxThinkingLevel(comboMaxThinking, perModelMaxThinking) {
  const comboIdx = comboMaxThinking ? THINKING_ORDER.indexOf(comboMaxThinking) : -1;
  const perModelIdx = perModelMaxThinking ? THINKING_ORDER.indexOf(perModelMaxThinking) : -1;
  if (comboIdx === -1) return perModelIdx === -1 ? null : perModelMaxThinking;
  if (perModelIdx === -1) return comboMaxThinking;
  return perModelIdx <= comboIdx ? perModelMaxThinking : comboMaxThinking;
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null, options = {}) {
  const t0 = Date.now();
  const entryPhases = { t0 };
  const errorContext = createErrorContext(request, options);
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body", errorContext);
  }
  entryPhases.parse_ms = Date.now() - t0;

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // One API-key read supplies validity, owner, binding and label for the whole
  // request. Every candidate/fallback below reuses this request-scoped snapshot.
  const [rawSettings, apiKeyContext] = await Promise.all([
    getSettings(),
    getApiKeyRoutingContext(apiKey),
  ]);
  const settings = await resolveScopedSettings(rawSettings, apiKey, apiKeyContext.owner);
  entryPhases.auth_ms = Date.now() - t0 - (entryPhases.parse_ms || 0);
  // undefined (not null) keeps the legacy combo lookup: name alone, ignoring ownership.
  const comboOwner = rawSettings.scopeResourcesByUser === true ? apiKeyContext.owner : undefined;
  // Refused unconditionally — an admin key is a dashboard-management
  // credential, not a routing one, whether or not requireApiKey is on.
  const adminRefusal = adminKeyRefusal(apiKeyContext.kind, errorContext);
  if (adminRefusal) return adminRefusal;
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key", errorContext);
    }
    if (!apiKeyContext.valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key", errorContext);
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model", errorContext);
  }

  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const route = (signal) => routeChat({
    body, modelStr, settings, comboOwner, apiKeyContext,
    clientRawRequest, request, apiKey, errorContext, signal, entryPhases,
  });
  const pathname = new URL(request.url).pathname;
  const clientFormat = detectFormatByEndpoint(pathname, body) || FORMATS.OPENAI;
  const streamsSSE = body.stream === true && (
    pathname.includes("/v1/chat/completions") ||
    pathname.includes("/v1/responses") ||
    pathname.includes("/v1/messages")
  );
  if (streamsSSE) {
    return createStreamingResponse(route, {
      clientFormat,
      signal: request.signal,
      requestId: errorContext.requestId,
    });
  }
  return route(request.signal);
}

async function routeChat({ body, modelStr, settings, comboOwner, apiKeyContext, clientRawRequest, request, apiKey, errorContext, signal, entryPhases }) {
  // Reuse request-scoped reads across model/account fallback. In distributed mode
  // these are Postgres round trips; re-reading the same settings/owner for every
  // candidate adds latency without changing the answer inside one request.
  const routingContext = { settings, comboOwner, apiKeyContext, entryPhases };
  const requiredCapabilities = detectRequiredCapabilities(body);
  const comboModels = await getComboModels(modelStr, comboOwner);
  if (comboModels) routingContext.comboName = modelStr;
  // This combo's own per-model thinking-cap map. Passed explicitly through the
  // handleSingleModel closures below (never stored on the shared routingContext)
  // so a nested-combo candidate resolving its own map can never clobber this one
  // for sibling fallback candidates in the same loop.
  const comboModelOptions = comboModels ? await getComboModelOptions(modelStr, comboOwner) : null;
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, errorContext, signal, routingContext, comboModelOptions);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
        errorContext,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, errorContext, signal, routingContext, comboModelOptions),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      errorContext,
    });
  }

  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, errorContext, signal, routingContext, null),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      errorContext,
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, errorContext, signal, routingContext, null);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, errorContext = {}, signal = null, routingContext = {}, comboModelOptions = null) {
  // Combo names are unique per owner. routeChat already resolved both values;
  // fallback recursion carries them instead of repeating the same DB reads.
  const comboOwner = routingContext.comboOwner;
  const chatSettings = routingContext.settings || await getSettings();
  const modelInfo = await getModelInfo(modelStr, comboOwner);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr, comboOwner);
    if (comboModels) {
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
      // Nested combo (modelStr here is itself a combo name found inside another
      // combo's models[]): resolve its own cap map locally. Deliberately independent
      // of the comboModelOptions parameter above — a nested combo's caps never
      // inherit or overwrite the outer combo's map for sibling candidates.
      const nestedModelOptions = await getComboModelOptions(modelStr, comboOwner);

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, errorContext, signal, routingContext, nestedModelOptions);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
          errorContext,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, errorContext, signal, routingContext, nestedModelOptions),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        errorContext,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format", errorContext);
  }

  const { provider, model } = modelInfo;
  const entryPhases = routingContext.entryPhases || {};
  if (entryPhases.t0 && entryPhases.routing_ms === undefined) {
    // Delta of this stage alone: the earlier stages are already counted, and a
    // cumulative value here would double-count them in any sum.
    entryPhases.routing_ms = Date.now() - entryPhases.t0 - (entryPhases.parse_ms || 0) - (entryPhases.auth_ms || 0);
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      apiKey,
      settings: chatSettings,
      keyOwner: comboOwner === undefined ? null : comboOwner,
      allowedConnectionIds: routingContext.apiKeyContext?.allowedConnectionIds ?? null,
    });

    if (credentials?.noActiveCredentials) {
      log.warn("AUTH", credentials.candidate.message);
      return responseFromRoutingCandidate(credentials.candidate, { ...errorContext, upstreamHeaders: lastHeaders });
    }
    if (credentials?.allRateLimited) {
      log.warn("CHAT", `[${provider}/${model}] ${credentials.candidate.message} (${credentials.retryAfterHuman})`);
      return responseFromRoutingCandidate(credentials.candidate, { ...errorContext, upstreamHeaders: lastHeaders });
    }
    if (credentials?.spendCapExceeded) {
      log.warn("AUTH", credentials.candidate.message);
      return responseFromRoutingCandidate(credentials.candidate, { ...errorContext, upstreamHeaders: lastHeaders });
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const maxThinkingLevel = resolveMaxThinkingLevel(
      comboModelOptions?.maxThinking ?? null,
      comboModelOptions?.modelOptions?.[modelStr]?.maxThinking ?? null
    );
    // Detect source format by endpoint + body
    const clientFormat = request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null;
    const coreOptions = {
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomPerApiKeyProject
        ? headroomProjectUrl(chatSettings.headroomUrl || DEFAULT_HEADROOM_URL, routingContext.apiKeyContext?.name)
        : (chatSettings.headroomUrl || DEFAULT_HEADROOM_URL),
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      maxThinkingLevel,
      errorContext,
      entryPhases,
      comboName: routingContext.comboName,
      signal,
      sourceFormatOverride: clientFormat,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    };
    const coreBody = { ...body, model: `${provider}/${model}` };
    // Bedrock and every non-native-Anthropic provider can't run Anthropic's
    // server-side web_search tool — the translator turns it into an inert
    // client tool otherwise. Native Anthropic (provider === "claude") always
    // runs it itself.
    const needsWebSearchEmulation = chatSettings.webSearchEmulation !== false
      && clientFormat === FORMATS.CLAUDE
      && provider !== "claude"
      && hasWebSearchServerTool(body);
    const result = needsWebSearchEmulation
      ? await emulateWebSearch({
        body: coreBody,
        stream: body.stream === true,
        provider,
        settings: chatSettings,
        apiKey,
        log,
        callCore: (b) => handleChatCore({ ...coreOptions, body: b }),
      })
      : await handleChatCore({ ...coreOptions, body: coreBody });

    if (result.success) return withRequestId(result.response, errorContext);
    if (result.status === 499 || signal?.aborted) return withRequestId(result.response, errorContext);

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Providers whose limit error carries no reset (Kiro 402): ask their usage API.
    if (!resetsAtMs) {
      resetsAtMs = await getExhaustedQuotaResetMs(provider, result.status, refreshedCredentials);
      if (resetsAtMs) log.warn("QUOTA", `[${provider}] quota exhausted — locking until ${new Date(resetsAtMs).toISOString()}`);
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return withRequestId(result.response, errorContext);
  }
}
