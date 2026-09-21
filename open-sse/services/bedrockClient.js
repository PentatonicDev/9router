import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClient } from "@aws-sdk/client-bedrock";

// Bedrock cross-region inference profile prefixes — the geo/routing segment
// that precedes the vendor id in a SYSTEM_DEFINED inference profile ("us.",
// "eu.", "global.", ...). A model id already carrying one of these must never
// get a connection's inferenceProfilePrefix prepended again (see
// resolveBedrockModelId below).
export const BEDROCK_INFERENCE_PROFILE_PREFIXES = [
  "us-gov", "us", "eu", "apac", "global", "jp", "au", "ca", "sa", "me", "af",
];

/**
 * Shared per-connection Bedrock client config — the single source of truth for
 * both the data-plane executor (open-sse/executors/bedrock.js) and the
 * control-plane model discovery (open-sse/services/bedrockModels.js), so the
 * two credential modes resolve identically wherever a Bedrock client is built.
 *
 * Two credential modes (providerSpecificData.authMethod), never mixed on one
 * client — sigv4 wins over bearer unless authSchemePreference is also set
 * (confirmed: SDK's default*HttpAuthSchemeProvider always lists sigv4 before
 * httpBearerAuth, for both @aws-sdk/client-bedrock-runtime AND
 * @aws-sdk/client-bedrock — dist-es/auth/httpAuthSchemeProvider.js declares
 * the same aws.auth#sigv4 + smithy.api#httpBearerAuth pair on both clients).
 * This is not academic: if a Bedrock-hosting box ever has ambient AWS
 * credentials (env vars, instance role), an api_key-mode client with no
 * authSchemePreference would get sigv4-signed with THOSE credentials instead
 * of using the connection's bearer token.
 * authSchemePreference takes the auth SHORT name ("httpBearerAuth"), not the
 * full scheme id ("smithy.api#httpBearerAuth") — verified by running
 * @smithy/core's actual resolveAuthOptions() (it does
 * `schemeId.split("#")[1] === preferredSchemeName`): the short form reorders
 * bearer first, the full-id form is silently a no-op and sigv4 stays first.
 * So each branch below only ever sets one of `token`/`credentials`:
 *   - "api_key": bearer token, scoped to THIS client instance only. Never reads/
 *     sets AWS_BEARER_TOKEN_BEDROCK (process-global env fallback) — that would
 *     leak one connection's token to every other Bedrock connection in this
 *     process. Build a fresh client per request/call rather than caching one
 *     across connections, for the same isolation reason.
 *   - "iam": accessKeyId/secretAccessKey/sessionToken, or the default provider
 *     chain (profile/env/instance role) when none are supplied.
 *
 * `region: "global"` is a pseudo-region for Bedrock's cross-region low-latency
 * routing (global.* inference profile ids) — invoked through a normal regional
 * SDK endpoint, not a literal "global" AWS region, which neither the runtime
 * nor the control-plane SDK client accepts. Both resolve it here to
 * providerSpecificData.homeRegion (falling back to "us-east-1"), so callers
 * (including discoverBedrockModels in bedrockModels.js) never need their own
 * copy of this fallback.
 */
export function buildBedrockClientConfig(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const region = psd.region === "global" ? (psd.homeRegion || "us-east-1") : (psd.region || "us-east-1");
  const clientConfig = { region };
  if (psd.endpoint) clientConfig.endpoint = psd.endpoint;

  if (psd.authMethod === "iam") {
    if (psd.accessKeyId) {
      clientConfig.credentials = {
        accessKeyId: psd.accessKeyId,
        secretAccessKey: psd.secretAccessKey,
        sessionToken: psd.sessionToken || undefined,
      };
    }
    // else: fall through to the SDK's default provider chain (profile/env/instance role).
  } else {
    clientConfig.token = { token: credentials?.apiKey };
    clientConfig.authSchemePreference = ["httpBearerAuth"];
  }
  return clientConfig;
}

/**
 * Resolves the modelId to send to Converse/ConverseStream: an ARN or a model
 * id already carrying a cross-region inference profile prefix is passed
 * through unchanged; only a bare vendor model id gets the connection's
 * inferenceProfilePrefix prepended. Discovery (bedrockModels.js) surfaces
 * profile ids that already have a geo prefix (e.g. "us.anthropic...",
 * "global.anthropic..."), so prepending unconditionally produced invalid
 * double-prefixed ids like "global.us.anthropic..." — see bedrock.js execute().
 */
export function resolveBedrockModelId(model, providerSpecificData) {
  if (!model) return model;
  if (model.startsWith("arn:aws:bedrock:")) return model;
  const firstSegment = model.split(".")[0];
  if (BEDROCK_INFERENCE_PROFILE_PREFIXES.includes(firstSegment)) return model;
  const prefix = providerSpecificData?.inferenceProfilePrefix;
  return prefix ? `${prefix}${model}` : model;
}

/** Data-plane client (Converse/ConverseStream) — one per request, never shared/cached. */
export function createBedrockRuntimeClient(credentials) {
  return new BedrockRuntimeClient(buildBedrockClientConfig(credentials));
}

/** Control-plane client (ListFoundationModels/ListInferenceProfiles/GetFoundationModelAvailability). */
export function createBedrockControlPlaneClient(credentials) {
  return new BedrockClient(buildBedrockClientConfig(credentials));
}
