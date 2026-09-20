import { AI_PROVIDERS } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  // Amazon Bedrock — authMethod discriminates the two shapes the executor reads
  // (open-sse/executors/bedrock.js), same "explicit discriminator field" pattern
  // Kiro uses for its 5 authMethod values, not shape-sniffing like Vertex.
  // Credentials are stored unencrypted in this JSON column, matching this
  // repo's existing convention for provider secrets (e.g. aws-polly.js's own
  // notice already documents "set providerSpecificData.accessKeyId" the same way).
  if (provider === "bedrock") {
    const authMethod = next.authMethod === "iam" ? "iam" : "api_key";
    next.authMethod = authMethod;
    next.region = (typeof next.region === "string" && next.region.trim()) || "us-east-1";
    const validPrefixes = new Set(["", "us.", "eu.", "apac.", "global."]);
    next.inferenceProfilePrefix = validPrefixes.has(next.inferenceProfilePrefix) ? next.inferenceProfilePrefix : "";
    if (typeof next.endpoint === "string" && next.endpoint.trim()) {
      next.endpoint = next.endpoint.trim();
    } else {
      delete next.endpoint;
    }

    if (authMethod === "iam") {
      next.accessKeyId = typeof next.accessKeyId === "string" ? next.accessKeyId.trim() : "";
      next.secretAccessKey = typeof next.secretAccessKey === "string" ? next.secretAccessKey.trim() : "";
      next.sessionToken = typeof next.sessionToken === "string" && next.sessionToken.trim() ? next.sessionToken.trim() : undefined;
    } else {
      delete next.accessKeyId;
      delete next.secretAccessKey;
      delete next.sessionToken;
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}
