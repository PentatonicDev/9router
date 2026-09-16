// Header names that carry a credential. Matched case-insensitively, and by
// substring for the families that vary by provider (x-goog-api-key, x-amz-security-token).
const SECRET_HEADER_EXACT = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-session-token",
  "x-access-token",
  "x-refresh-token",
  "x-copilot-token",
]);

const SECRET_HEADER_SUBSTRING = ["api-key", "apikey", "token", "secret", "auth", "credential", "password", "signature", "bearer", "sso"];

export function isSecretHeader(name) {
  const key = String(name || "").toLowerCase();
  if (SECRET_HEADER_EXACT.has(key)) return true;
  return SECRET_HEADER_SUBSTRING.some((needle) => key.includes(needle));
}

/**
 * Replace credential header values with a placeholder, keeping the header names.
 *
 * Debug surfaces need to show which headers a provider receives without handing
 * out the credential itself: a viewer who can see the shape of the request has
 * no reason to receive a live token with it.
 */
/**
 * @param {object} headers
 * @param {string[]} [secrets] credential values to scrub wherever they appear.
 *   A name list alone is not enough: Kiro carries its bearer in
 *   `x-amz-sso-bearer`, whose name contains none of the usual markers. Matching
 *   the value too means a provider inventing another header name still cannot
 *   leak a token that is known to us.
 */
export function redactHeaders(headers, secrets = []) {
  if (!headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSecretHeader(name) ? "«redacted»" : redactSecretValues(value, secrets);
  }
  return out;
}

const SECRET_QUERY_PARAMS = ["key", "api_key", "apikey", "access_token", "token", "sig", "signature"];

/**
 * Strip credentials carried in a URL's query string (Vertex sends `?key=<apiKey>`).
 * Returns the input unchanged when it does not parse as a URL.
 */
export function redactUrl(url) {
  if (typeof url !== "string" || !url) return url;
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.includes(name.toLowerCase())) {
        parsed.searchParams.set(name, "«redacted»");
        touched = true;
      }
    }
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      touched = true;
    }
    return touched ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Replace occurrences of known credential values anywhere in a payload.
 *
 * Some executors embed the token in the request body rather than a header
 * (Windsurf builds it into the protobuf payload, CommandCode into its envelope),
 * so redacting headers alone would still hand the secret over. Matching by value
 * covers those without having to know each executor's field names.
 */
export function redactSecretValues(payload, secrets) {
  const values = [...new Set((secrets || []).filter((v) => typeof v === "string" && v.length >= 8))];
  if (!values.length || payload == null) return payload;

  const scrub = (text) => values.reduce((acc, secret) => acc.split(secret).join("«redacted»"), text);

  const walk = (node) => {
    if (typeof node === "string") return scrub(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(payload);
}
