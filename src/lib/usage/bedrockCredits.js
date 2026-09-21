import { getConnectionSpend } from "@/lib/db/index.js";
import { getBedrockQuotaSnapshot } from "open-sse/services/bedrockQuotas.js";
import { nextUtcMidnightMs } from "open-sse/executors/bedrock.js";
import { stripBedrockGeoPrefix } from "open-sse/providers/bedrockGeoPrefix.js";

const NO_ROWS_MESSAGE = "Set Credits (USD) on this connection, or use IAM credentials so Bedrock quotas can be read.";

function creditsRow(creditsUsd, spentUsd) {
  const credits = Number(creditsUsd);
  if (!Number.isFinite(credits) || credits <= 0) return null;
  // 4 decimals: a fresh account spends fractions of a cent per call, and 2
  // decimals would show "0" for the first few hundred requests.
  const used = Math.round((Number(spentUsd) || 0) * 10000) / 10000;
  return { "Credits (USD)": { used, total: credits, resetAt: null, unlimited: false } };
}

// "global.anthropic.claude-haiku-4-5-20251001-v1:0" -> "global · claude-haiku-4-5-20251001";
// the vendor stays when the rest alone would be meaningless ("deepseek.v3.2").
function shortModelLabel(id) {
  const bare = stripBedrockGeoPrefix(id);
  const geo = bare === id ? "" : `${id.slice(0, id.length - bare.length - 1)} · `;
  const noVendor = bare.replace(/^[a-z0-9-]+\./, "");
  return geo + (/^v?\d/.test(noVendor) ? bare : noVendor).replace(/-v\d+(:\d+)?$/, "");
}

// Quota rows from a getBedrockQuotaSnapshot() result. AWS publishes no daily
// quota for its newest models; those rows still show today's consumption,
// flagged as unlimited so the tracker does not paint them as depleted.
function quotaRows(snapshot, now) {
  const rows = {};
  if (!snapshot) return rows;
  const resetAt = new Date(nextUtcMidnightMs(now)).toISOString();
  if (snapshot.account?.dailyQuota > 0) {
    rows["Tokens today · all models"] = { used: snapshot.account.tokensToday || 0, total: snapshot.account.dailyQuota, resetAt, unlimited: false };
  }
  for (const m of snapshot.models || []) {
    if (!(m.tokensToday > 0) && !(m.dailyQuota > 0)) continue;
    const label = shortModelLabel(m.id);
    rows[m.dailyQuota > 0 ? `Tokens today · ${label}` : `Tokens today · ${label} (daily limit unpublished)`] = m.dailyQuota > 0
      ? { used: m.tokensToday || 0, total: m.dailyQuota, resetAt, unlimited: false }
      : { used: m.tokensToday || 0, total: 0, resetAt, unlimited: true };
  }
  return rows;
}

/**
 * Quota-tracker shape for a Bedrock connection: the credit ceiling (lifetime
 * spend vs credits purchased) plus today's token consumption against the
 * account's published quotas.
 * ponytail: credits are all-time (no monthly reset) and the token day is the
 * UTC day — AWS does not publish when "per day" quotas roll over.
 */
export function buildBedrockCreditsUsage(creditsUsd, spentUsd, snapshot = null, now = Date.now()) {
  const quotas = { ...(creditsRow(creditsUsd, spentUsd) || {}), ...quotaRows(snapshot, now) };
  if (!Object.keys(quotas).length) {
    const detail = snapshot?.errors?.length ? ` ${snapshot.errors[0]}` : "";
    return { message: NO_ROWS_MESSAGE + detail };
  }
  const out = { plan: "Amazon Bedrock", quotas };
  if (snapshot?.errors?.length) out.warning = snapshot.errors.join(" ");
  return out;
}

export async function getBedrockCreditsUsage(connection) {
  const psd = connection?.providerSpecificData || {};
  const [spentUsd, snapshot] = await Promise.all([
    getConnectionSpend(connection.id),
    psd.authMethod === "iam"
      ? getBedrockQuotaSnapshot({ apiKey: connection.apiKey, providerSpecificData: psd }).catch((e) => ({ errors: [e?.message || String(e)] }))
      : Promise.resolve(null),
  ]);
  return buildBedrockCreditsUsage(psd.creditsUsd, spentUsd, snapshot);
}
