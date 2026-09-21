import { getConnectionSpend } from "@/lib/db/index.js";

/**
 * Quota-tracker shape for a Bedrock connection's credit ceiling: "used" is
 * lifetime spend against "total" credits purchased.
 * ponytail: credits are all-time (no monthly/period reset) — the number the
 * user enters is treated as the total ever purchased. Per-period credit
 * windows (e.g. a monthly AWS credit grant) aren't modeled; upgrade path is
 * a periodKey similar to spendLedgerRepo.js's TOTAL_PERIOD_KEY/month split.
 */
export function buildBedrockCreditsUsage(creditsUsd, spentUsd) {
  const credits = Number(creditsUsd);
  if (!Number.isFinite(credits) || credits <= 0) {
    return { message: "Set Credits (USD) on this connection to track spend against it." };
  }

  // 4 decimals: a fresh account spends fractions of a cent per call, and 2
  // decimals would show "0" for the first few hundred requests.
  const used = Math.round((Number(spentUsd) || 0) * 10000) / 10000;
  return {
    plan: "Amazon Bedrock credits",
    quotas: {
      "Credits (USD)": { used, total: credits, resetAt: null, unlimited: false },
    },
  };
}

export async function getBedrockCreditsUsage(connection) {
  const creditsUsd = connection?.providerSpecificData?.creditsUsd;
  const spentUsd = await getConnectionSpend(connection.id);
  return buildBedrockCreditsUsage(creditsUsd, spentUsd);
}
