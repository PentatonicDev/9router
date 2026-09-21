import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { createBedrockRuntimeClient, resolveBedrockModelId } from "../services/bedrockClient.js";

const encoder = new TextEncoder();

// AWS exception name -> HTTP status. Documented AWS convention (exception class +
// $fault), not independently live-probed against a real Bedrock endpoint in this
// pass — see rel-critique.md reader notes. ModelNotReadyException/ThrottlingException/
// InternalServerException/ServiceUnavailableException are auto-retried by the SDK
// itself (up to 5x) before ever reaching this map.
const ERROR_STATUS_MAP = {
  ThrottlingException: HTTP_STATUS.RATE_LIMITED,
  ServiceQuotaExceededException: HTTP_STATUS.RATE_LIMITED,
  ModelNotReadyException: HTTP_STATUS.RATE_LIMITED,
  ValidationException: HTTP_STATUS.BAD_REQUEST,
  AccessDeniedException: HTTP_STATUS.FORBIDDEN,
  UnrecognizedClientException: HTTP_STATUS.UNAUTHORIZED,
  ExpiredTokenException: HTTP_STATUS.UNAUTHORIZED,
  InvalidSignatureException: HTTP_STATUS.UNAUTHORIZED,
  ResourceNotFoundException: HTTP_STATUS.NOT_FOUND,
  ConflictException: HTTP_STATUS.CONFLICT,
  ModelTimeoutException: HTTP_STATUS.GATEWAY_TIMEOUT,
  ServiceUnavailableException: HTTP_STATUS.SERVICE_UNAVAILABLE,
  InternalServerException: HTTP_STATUS.SERVER_ERROR,
  ModelStreamErrorException: HTTP_STATUS.SERVER_ERROR,
};

function mapBedrockError(err) {
  const status = ERROR_STATUS_MAP[err?.name] || HTTP_STATUS.BAD_GATEWAY;
  return { status, message: err?.message || err?.name || "Bedrock request failed" };
}

// Single mid-stream exception event (messageStop never arrived) -> the same
// {error:{message}} shape bedrockConverseToOpenAIResponse expects from extractStreamError.
function streamExceptionFrame(err) {
  return `data: ${JSON.stringify({ error: { message: err?.message || String(err) } })}\n\n`;
}

/**
 * BedrockExecutor — Amazon Bedrock Converse/ConverseStream, one generic executor
 * for every vendor Bedrock hosts (Anthropic, Nova, Llama, Mistral, DeepSeek, Qwen,
 * Cohere). See open-sse/AGENTS.md + open-sse/providers/registry/bedrock.js.
 *
 * Client config (credential-mode branching, region, endpoint) is shared with
 * model discovery (open-sse/services/bedrockModels.js) via
 * open-sse/services/bedrockClient.js — see that file's doc comment for the
 * full auth-scheme rationale (this is where "api_key mode sets token +
 * authSchemePreference: [\"httpBearerAuth\"]" is proven against @smithy/core).
 */
export class BedrockExecutor extends BaseExecutor {
  constructor() {
    super("bedrock", PROVIDERS.bedrock);
  }

  parseError(response, bodyText) {
    let parsed = null;
    try { parsed = JSON.parse(bodyText || "{}"); } catch { parsed = null; }
    return { status: response.status, message: parsed?.error?.message || bodyText || `HTTP ${response.status}` };
  }

  buildClient(credentials) {
    return createBedrockRuntimeClient(credentials);
  }

  async execute({ model, body, credentials, signal, log }) {
    const psd = credentials?.providerSpecificData || {};
    const modelId = resolveBedrockModelId(model, psd);

    // One client per request — never cached/shared across connections (see class doc).
    const client = this.buildClient(credentials);

    let result;
    try {
      result = await client.send(new ConverseStreamCommand({ modelId, ...body }), { abortSignal: signal });
    } catch (err) {
      const { status, message } = mapBedrockError(err);
      log?.warn?.("BEDROCK", `${model} | ${err?.name || "Error"} (${status}): ${message}`);
      return {
        response: new Response(JSON.stringify({ error: { message } }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const evt of result.stream) {
            // The 5 named exception members of ConverseStreamOutput
            // (internalServerException, modelStreamErrorException,
            // validationException, throttlingException,
            // serviceUnavailableException) arrive as normal events through this
            // loop, not as a thrown rejection — re-encode the same way a thrown
            // mid-stream error is (below), instead of forwarding the raw
            // Bedrock shape, and stop: extractStreamError() in the generic SSE
            // pipeline (open-sse/utils/stream.js) only recognizes `chunk.error`
            // on the *raw* pre-translation chunk, before the response
            // translator ever sees it — passed through raw, the translator has
            // no error-shaped chunk to return and there is nothing left for it
            // to translate after a fatal exception anyway.
            const exceptionKey = Object.keys(evt).find((k) => k.endsWith("Exception"));
            if (exceptionKey) {
              log?.warn?.("BEDROCK", `${model} | ${exceptionKey}: ${evt[exceptionKey]?.message || ""}`);
              controller.enqueue(encoder.encode(streamExceptionFrame(evt[exceptionKey])));
              break;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
          }
        } catch (err) {
          // Mid-stream failure inside the async iterable itself: connection
          // drop, SDK-level error — distinct from the in-band exception events
          // handled above.
          log?.warn?.("BEDROCK", `${model} | stream error: ${err?.message || err}`);
          controller.enqueue(encoder.encode(streamExceptionFrame(err)));
        } finally {
          controller.enqueue(encoder.encode(SSE_DONE));
          controller.close();
        }
      },
    });

    return { response: new Response(stream, { headers: SSE_HEADERS }) };
  }
}
