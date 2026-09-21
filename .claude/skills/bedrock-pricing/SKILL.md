---
name: bedrock-pricing
description: Regenerate open-sse/providers/bedrockPricing.js (Amazon Bedrock USD per 1M tokens, keyed by exact model id) from models.dev. Use when Gilson asks to update, refresh or sync Bedrock prices, or when a Bedrock model shows cost 0 because it is missing from the table.
---

# Bedrock pricing refresh

The Bedrock price table is generated, never hand-edited. Prices depend on the geo
prefix (`us.`/`eu.`/`jp.`/`au.`/`apac.` profiles list ~10% above the bare id,
`global.` matches it), so keys are exact Bedrock ids.

## Steps

1. From the repo root run:
   ```bash
   node .claude/skills/bedrock-pricing/sync-bedrock-pricing.mjs
   ```
   It fetches https://models.dev/api.json, takes the `amazon-bedrock` provider and
   rewrites `open-sse/providers/bedrockPricing.js` (input, output, cached = cache
   read, cache_creation = cache write). Context tiers above 200k are ignored.
2. Review `git diff --stat open-sse/providers/bedrockPricing.js` and spot-check one
   Anthropic id against https://aws.amazon.com/bedrock/pricing/ when a price moved.
3. Run the pricing tests:
   ```bash
   npx vitest run --config tests/vitest.config.js tests/unit/bedrock-pricing-canonical.test.js tests/unit/bedrock-geo-prefix-lookup.test.js
   ```
   A test that pins a specific number (Sonnet 5 at 2.0/2.2, Opus 4.6 global at 5.0)
   fails when models.dev changes that price: update the expectation to the new value,
   do not skip the test.
4. Report the model count and the ids whose price changed. Ids models.dev does not
   list still resolve through the canonical-name fallback in
   `open-sse/providers/pricing.js`.
