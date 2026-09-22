# Unreleased

## Features
- **System One (jev) decision routing**: a **Decisions** kind inside a renamed **Tools Providers** sidebar section (the former Media Providers) — a decision model is a tool the gateway offers, not a category of its own. The gateway IS the provider: `vercel-ai-gateway` declares `serviceKinds` "decision" plus a `decisionConfig`, reuses its own connection's key so no second credential is registered, and swapping to a better System-1 model is editing one field (decision models carry `type: "evaluation"` in the gateway's own catalog, which is how they are told from chat models). TypeSafe's `jev` answers typed questions (`choice` / `score` / `noul`) with calibrated probabilities in 300-400ms (p50 measured over 76 calls) and emits no text at all, so it never serves a completion — it picks the model or the tool and the existing chat model does the work. `mode` is `off` | `shadow` | `enforce`, shipping `off` with an empty allowlist, so nothing routes until it is configured. Costs go on their own usage row under `typesafe` (input-only, $0.042/1M from `PROVIDER_PRICING`) instead of being folded into the request's tokens, which would have billed the decision at the serving model's rate. Every discard names its reason — no credentials, no questions, an HTTP status, a timeout, an empty answer — because a bare null is indistinguishable from an outage. `x-9router-decision: off` disables it for one request.
- **Combos**: a fourth strategy, **`auto`**. jev sees the pool and the conversation and puts the model whose brief best fits the turn first; the existing fallback loop still walks the rest, so a wrong pick costs one attempt (a model with no active credential, or one missing the required capability — the capability reorder still runs afterwards and corrects it) rather than a failure. Measured on a three-model pool through a session that hardens: `renomeia variavel + lint` → haiku (confidence 1.00), `implementa endpoint CSV + testes` → sonnet (0.99), `memory leak intermitente em produção` → opus (0.88), with the independent "needs deliberation" question rising in step (0.19 → 0.77 → 0.90). Changes are governed by confidence rather than a counter, because a counter was measured wrong: three different tiers across three turns means a three-in-a-row requirement would never switch at all. Below `minConfidence` (0.7) nothing changes; between 0.7 and `switchConfidence` (0.85) a second identical verdict is required; at or above 0.85 it changes on the same turn. That matters because switching models discards the prompt cache: on a 60k prefix at $5/M the rewrite costs about $0.375, roughly twelve cached turns.
- **Decision routing**: the text handed to jev per model is the feature, not a detail. A criteria built automatically from price and capability flags decided 0/4 of the tasks correctly (confidence 0.43–0.47, discarded by the threshold); a curated brief saying what each model is FOR decided 5/5 (0.96–0.99), including routing a production race condition to the reasoning model instead of the cheapest one. `open-sse/decision/modelBriefs.js` ships briefs for the common Claude and GPT models, an operator's own text overrides them, and price is appended live from `getPricingForModel` so the brief never goes stale. A non-model option in a model question must never be offered: `no_tool_needed` as a choice absorbed 39–45% of the probability mass and wrecked the decision.
- **Decision routing (tools)**: the roster and the conversation are offered to jev as a choice over tool names plus an independent "is a tool needed now?" question, and neither acts unless the two agree. Modes are `off` (the request is never touched, so model routing runs alone), `hint` (a `<system-reminder>` appended at the **tail** — deliberately not `rtk/systemInject.js`, which splices *before* the last `cache_control`, right for the stable caveman/ponytail prompts but wrong for a hint, which names this turn's tool and would rewrite the prefix every request), and `forced`. `toolMode` is a ceiling, so a verdict above it downgrades to a hint instead of being dropped. `tool_choice` is a top-level parameter and does **not** enter the prompt cache — measured, the same 3,584 tokens are read with and without the change — so mutating it is free, and the earlier "only hint when cached" rule was deleted as unnecessary. Pinning `tool_choice: none` is deliberately absent from the UI: measured, it failed every coding task (0/3, 2.9s each, fixture untouched) because the model then writes its tool call as text the client cannot run. Provider-run and namespaced tools are never forced. Six executors speak binary or NDJSON upstream and never reach the translator (`kiro`, `cursor`, `commandcode`, `windsurf`, `devin-cli`, `zed`): tool routing passes through there, while auto-combo still works since it only changes `model`. Fails open on every path. A roster past 255 options is not judged at all (measured: 281 tools is a hard 400); `shortlistTools` narrows a large roster deterministically first, which took a 280-tool roster from 0.40 confidence to 0.94 and the question from 4,400 tokens to 1,288.
- **Decision routing**: the decision is memoised per request. One request can reach that point more than once — every account retry re-runs the core, and web-search emulation iterates up to eight times — and jev bills input, so nine serial calls would cost tokens and add seconds, past the 1500ms stream grace. Keyed on a signature of the conversation, so a retry of the same body reuses the decision while an appended tool result gets its own.
- **Decision routing**: `scripts/bench-jev.mjs` measures what the code cannot show — whether the tier matched the task, and whether the saving survives the prompt cache. Needs a running gateway and a combo: `node scripts/bench-jev.mjs --combo my-auto-combo --session`. Run it once with `mode: off` and once with `enforce` and compare tokens and latency; the allowlist ships empty and the mode ships `off` on purpose, because the jev-gateway's own benchmark found routing made some models worse on feature work.
- **System One**: the reasoning budget is capped **per turn** from the same verdict that picks the model. The decision already produces a deliberation score every turn and it was being discarded; it now feeds the ceiling that the per-combo and per-model `maxThinking` already used. Only the bottom of the range is capped — under 0.3 caps at `low`, under 0.7 at `medium`, and a hard turn is left alone so the client's own request stands, because a ceiling can only lower a budget and never raise it. Off by default and separate from `mode`, since the two levers carry different evidence. Measured on Bedrock Sonnet 4.6: `budget_tokens` 1024 produced 223 chars of thinking against 4,460 at 24576, with 28% fewer output tokens and 28% less latency.
- **System One**: `scripts/bench-harness.mjs` measures a real agent harness against a running gateway, end to end. Each task ships its fixture inline with a check that fails before the work and passes after, so "passed" always means the agent did it. Two runs compare two router settings and nothing else: the harness is identical in both, which is the only way a routing result can be attributed to the router. `node scripts/bench-harness.mjs --model <combo>`.
- **Distributed mode**: background work is coordinated across instances through a DB-backed lease (`jobLeases` table, `src/lib/db/leases.js`): one atomic claim that runs identically on SQLite and Postgres, so callers carry no mode branches and a single instance simply always wins. OAuth token refresh takes a per-connection lease on every path (background tick, per-request, reactive 401/403, dashboard and quota routes) and re-reads the connection before calling the provider, so only one instance rotates a refresh token — co-booted instances used to race and the loser got `invalid_grant`. Quota unlock, quota auto-ping (per connection and reset window) and the daily model catalog sync run once per deployment; catalog losers adopt the winner's copy from the shared `kv` table instead of calling models.dev.
- **Amazon Bedrock**: new provider `bedrock` (alias `br`) built on the Converse API, so every model Bedrock hosts (Anthropic Claude, Amazon Nova, Meta Llama, Mistral, DeepSeek, Qwen, Cohere) runs through one translator pair, with tool calls, images, usage and cache accounting. Two credential modes per connection, never mixed: a Bedrock API key (Bearer, with the SDK's scheme preference pinned so ambient AWS credentials on the host can never sign that connection) or IAM access key/secret/session token (or the SDK default chain when left empty). Region is configurable per connection, including `global` (served through a home region with `global.*` inference profiles), plus inference-profile prefix and endpoint override. Pre-stream AWS errors keep their real status (429/400/401/403/404/503/504) so cooldown and fallback rules apply; mid-stream errors arrive as in-band frames. Claude extended thinking maps to `additionalModelRequestFields.thinking`.
- **Amazon Bedrock**: model discovery per connection. "Discover models" in the Add-connection dialog (preview, nothing persisted) and a refresh action on the connection list the account's on-demand text models and system inference profiles for the chosen region, or the `global.*` profiles for `global`, with per-model access status when the credential may check it. Discovered ids appear as the connection's available models in the dashboard and in `/v1/models`. Works identically with API key and IAM credentials.
- **API keys**: two kinds. Usage keys route `/v1` traffic as before. An administration key (one per owner, admin-created, "Administration key" card on the Keys page) drives the dashboard REST API with `Authorization: Bearer` or `x-api-key` as its owner, with exactly the scope that owner has when logged in; it is refused on every `/v1` route. This supersedes the `management` flag: existing flagged keys become administration keys on boot, oldest per owner. The request-details API accepts both kinds, scoped to the owner.
- **Spend caps**: a usage key can carry a spend cap per bound consumption-billed account (`connectionBudgets`, USD per calendar month or total), edited on the key's Accounts page. Spend is written to a `spendLedger` inside the usage transaction (row-locked on Postgres) and read when an account is picked: capped accounts are skipped so combo fallback continues, and a pool with nothing left answers 402 `spend_cap_exceeded`. A warning is logged at 80%. `GET /api/keys/{id}/spend` reports spent vs limit. Providers now declare `billing` (`usage` or `subscription`, derived from OAuth vs API key); caps only apply to usage-billed accounts, and only bind when the model has a known price.
- **Amazon Bedrock**: optional **Credits (USD)** per connection (Add and Edit dialogs, `providerSpecificData.creditsUsd`). When set, the connection appears in the Quota Tracker with a "Credits (USD)" row: used = the connection's lifetime spend from usage history, total = the credits entered; clearing the field removes it from the tracker.
- **Combos**: a combo-wide thinking cap (`maxThinking`) alongside the per-model one; the lower of the two applies to each candidate.
- **Combos**: each model entry can carry a thinking cap (`modelOptions[model].maxThinking`, levels `none` … `max`), set per row in the Edit Combo dialog or via `POST/PUT /api/combos`. When the client asks for more (a Claude `budget_tokens` of 32000 maps to `xhigh`), the candidate is clamped down before translation; lower requests, `auto` and disabled thinking pass through untouched. Built for fallbacks such as `cc/claude-opus-5 → cx/gpt-5.6-sol`, where Opus-level thinking turned into 40–170s Codex reasoning turns.
- **API keys**: a per-key "Can manage dashboard" flag (`management`, admin-set in the key's edit dialog or via `/api/keys`). Such a key authenticates the dashboard REST API (`/api/combos`, `/api/providers`, `/api/keys`, `/api/settings`, `/api/usage`, …) with `Authorization: Bearer` or `x-api-key` as its owner, with the same per-owner scoping a dashboard session gets; `@admin` and `ssoAdminEmails` owners are admins. Header credentials only; keys without an owner or without the flag are refused; process-spawning and host-secret routes stay session-only.
- **Observability**: `GET /v1/admin/request-details` (and `/v1/admin/request-details/{id}`) expose the stored request metrics — latency, phases, tokens, provider, model, status, comboName, upstream summary — for `curl`-based debugging. Any active API key with an owner may call it once `requireLogin` and `enableObservability` are both on; a non-admin owner sees only the rows of its own keys and accounts (filtered in SQL, so pagination counts are exact), an admin owner sees everything. The collection route strips request/provider bodies unless `?full=1` is given, the by-id route returns the full stored record and answers 404 outside the caller's scope.

## Fixes
- **Amazon Bedrock**: extended thinking was silently dropped on the non-streaming path. Bedrock always replies over `ConverseStream`, so a non-streaming request is aggregated from SSE and then shaped for the client — and that path had its own copy of the reasoning strip with no output-format guard (the same unconditional strip fixed in `nonStreamingHandler.js` and left behind in `sseToJsonHandler`). A Claude client turns `reasoning_content` into a `thinking` block, so deleting it there removed extended thinking before it could be mapped: measured, a non-streaming `/v1/messages` request against Sonnet 4.6 with `budget_tokens` 24576 returned `content: [{type:"text"}]` with no thinking while the identical streaming request returned a thinking block. Bedrock bills those tokens, so the work was paid for and thrown away. The strip now applies only where the client has nowhere to put reasoning.
- **Amazon Bedrock**: with Caveman or Ponytail on, every Bedrock call failed with `Unexpected field type`: the system-prompt injector treated the Converse body as OpenAI Chat and pushed a `system` role into `messages[]`. It now appends to the top-level `system: [{text}]` block.
- **Amazon Bedrock**: cost capture. Converse reports `inputTokens` without cache tokens (measured: input 15, cacheRead 32358), but the usage extractor stored it as the cache-inclusive `prompt_tokens`, so cached requests logged a tiny prompt count and dropped the uncached input from the cost. Cache read/write are now folded in like the Anthropic extractor does.
- **Amazon Bedrock**: pricing resolved for 22 of the 88 model ids a real account discovers, and the hand-written table assumed Bedrock charged direct-API rates. The table is now generated from models.dev's Bedrock catalog (`open-sse/providers/bedrockPricing.js`, 165 ids with cache read/write rates, regenerated on request by the repo's `bedrock-pricing` skill) and keyed by the exact id, because a regional cross-region profile (`us.`, `eu.`, `jp.`, ...) lists about 10% above the bare or `global.` id. Ids the catalog does not know yet fall back to their canonical name (`global.moonshotai.kimi-k3` → `kimi-k3`) in the provider-agnostic tables. Usage rows record the id the executor actually invoked, so a connection-level inference-profile prefix is billed at its own rate.
- **Amazon Bedrock**: prompt caching. The Converse body never carried a `cachePoint`, so every Claude Code turn through a `br/` model paid full input price. The translator now places checkpoints after the system prompt, after the tool definitions and after the latest message for Anthropic models (system and messages only for Nova; nothing for vendors that reject them), and the Caveman/Ponytail prompts are inserted inside the cached prefix. Measured on Haiku 4.5: the second identical call read 27,866 tokens from cache and cost 12× less.
- **Amazon Bedrock**: a 429 `Too many tokens per day` locks that model on the account until the next UTC midnight instead of a short cooldown, so combos fall back for the rest of the day rather than retrying into the same wall.
- **Web search for any upstream**: Anthropic's `web_search` server tool is emulated inside the gateway for Claude-format clients whenever the upstream cannot run it (Bedrock, OpenAI-compatible, everything but native Anthropic). The model gets a real `web_search` tool, the gateway runs each query through the configured search source (SearXNG, Tavily, Brave, Exa, … or a search combo) with the same auth and fallback as `/v1/search`, feeds the results back and loops until the model answers (`max_uses` honored, hard cap 8). The client receives genuine `server_tool_use` and `web_search_tool_result` blocks, `usage.server_tool_use.web_search_requests`, and the same shapes in streaming, so Claude Code shows the searches and the sources. Replayed history converts those blocks for the next turn. Configured on the Web Search page: toggle and source. The SearXNG base URL lives on the SearXNG provider panel, with a Test button that runs a JSON search against it and names the SearXNG limiter when it answers 429 (the limiter blocks API calls: turn it off or whitelist the gateway in `limiter.toml`) (admin-set, so private or Docker-internal hosts are accepted; the `SEARXNG_URL` env stays the default). Measured with Claude Code on Bedrock Haiku: one search, sources listed, the answer cited the URL.
- **Combos**: `/v1/models` lists each combo with `context_length` and `max_completion_tokens` taken from the member a request would reach now (first entry whose provider has an active connection not locked for that model). Clients that size their context window from the catalog (Hermes logged "Could not detect context length … defaulting to 256,000") stop guessing.
- **Amazon Bedrock**: Converse rejects tool definitions Claude Code sends routinely: an empty `description` (400 "length greater than or equal to 1") and MCP tool names above 64 characters (`mcp__server__tool…`). Empty descriptions are omitted, and long or invalid names are shortened with the same sanitizer Kiro uses, mapped back to the client's name on the streamed and aggregated tool calls, and applied to `tool_choice` and to tool uses replayed in history.
- **Amazon Bedrock**: Claude Code failed with `Expected toolResult blocks at messages.N.content for the following Ids` whenever a turn had more than one tool call. The OpenAI pivot emits one `tool` message per call and Converse wants every `toolResult` of the turn in one user message; consecutive same-role messages are now merged.
- **Amazon Bedrock**: the model picker (combos, key restrictions) listed only the built-in Bedrock catalog; it now shows the connection's discovered models and inference profiles, like Cursor and Cline.
- **Tests**: the suite is green again (was 86 failures across 28 files, catalogued as "expected" for months). Each failure was traced to its cause: stale expectations after deliberate changes (Kiro `q.` endpoint order, Windsurf chat host, Antigravity 429 retries, Cursor auto-import lookup, NDJSON opt-in, mid-conversation system fold), mocks that stopped matching the code (DNS `all:true` records, Cursor HTTP/2 catalog, dead `require` mock), four files written for `node:test` that vitest never collected, tests for code that does not live in this repo (cloud embeddings, lowdb benchmark, a Cursor MCP codec that was never written), and cwd-dependent paths in the security audit. Live probes now skip unless opted in. `verify-no-regression.mjs` works outside the CI container and `known-fails.txt` is empty.
- **CommandCode**: image blocks carried a stray `mediaType` key next to `mimeType`, and a mid-stream `error` event threw inside the executor's transform, killing the stream with nothing delivered to the client; it is now emitted as a readable error chunk.
- **Translator**: an OpenAI assistant turn's `reasoning_content` is replayed to Claude-format upstreams as a thinking block only where the upstream tolerates unsigned or sentinel-signed thinking (anthropic-compatible, DeepSeek). Native Anthropic verifies signatures, so there it is dropped as before rather than forged.
- **Usage**: the usage returned to the client no longer carries a 2,000-token pad on top of the provider's real count (it inflated `input_tokens`/`prompt_tokens` on every response, so Claude Code's cost display and any client-side spend tracking ran high). The pad stays only on usage the gateway estimates itself when a provider sends none.
- **Console Log**: the pod picker only lists instances that wrote in the last 15 minutes, so pods that no longer exist stop appearing.
- **Usage**: `usageDaily` and the lifetime request counter lost concurrent updates on Postgres (read, merge in JS, write back with no lock); the rows are now seeded and locked with `SELECT ... FOR UPDATE` inside the transaction. 50 concurrent writes count 50 (was 1). SQLite is unchanged.
- **Quota jobs**: auto-ping and unlock start on process boot (`instrumentation.js`) instead of on the first dashboard render, so an instance serving only `/v1` runs them too.
- **Token refresh**: a non-OK refresh response is returned as an error object instead of `null`; a permanent one (`invalid_grant`) stops the retry loop instead of resending a dead refresh token, a transient one still retries with backoff.
- **DB**: a failed adapter initialisation no longer wedges every later database call behind the same rejected promise.
- **Build**: the standalone server (Docker image) failed every route with `Cannot find module '../../webpack-runtime.js'`. Next applies `outputFileTracingExcludes` with substring matching, so the `./.next/**` and `./logs/**` entries stripped the webpack runtime and Next's own `dev/browser-logs` from the traced output. Only the upstream `gitbook` exclude remains.
- **Codex**: time to first token no longer absorbs the whole reasoning phase. The in-band error peek used to wait for `output_text.delta` (draining up to 256KB); it now releases at the first event past the `response.created`/`response.in_progress` preamble, so reasoning summaries stream live while a capacity or overload error that follows the preamble still rotates accounts.
- **Usage**: request details record per-phase latency (parse, auth, routing, translate, preprocess, upstream connect, Codex peek, first client byte, first content, completion) and the combo name, shown in the request drawer. TTFT now means first useful content, including Claude-native passthrough streams; non-streamed calls report no TTFT instead of copying the total.
- **Logs**: debug request logs (`ENABLE_REQUEST_LOGS`) redact credential headers and are pruned on boot (200 sessions / 7 days; sessions that still hold raw credentials are removed regardless of age).
- **Stream**: open the client SSE response as soon as a `stream: true` request is authenticated, so routing, combo/account fallback and provider prefill no longer leave the connection silent — reverse proxies (Cloudflare's 125s Proxy Read Timeout) answered 524 before upstream headers existed. Heartbeats are SSE comments, suppressed while a partial event is in flight, and the final client-facing stream is relayed unchanged. A failure that resolves before the stream opens now travels in-band in the client's format (OpenAI error frame + `[DONE]`, Claude `event: error`, Responses `event: response.failed` + `[DONE]`) instead of dropping the connection.
- **Stream**: cancel the upstream request when the client disconnects, and stop locking the account when the abort is what ended the request.
- **Codex**: a Responses turn that ends on `response.incomplete` now reaches chat-completions and Claude clients as `finish_reason: "length"` (or `"content_filter"`) instead of a silently empty stream with no finish reason and no error.
- **Usage**: the Request Details drawer shows the stored request/provider bodies to admin sessions (password login or `ssoAdminEmails`); other sessions and anonymous access with `requireLogin` off keep them redacted.
- **Observability**: streamed request details record an upstream terminal summary (terminal event, response status, incomplete reason, error, per-event counts) so an empty-output turn shows why it ended; the stored status also flips to `error` when the upstream terminal was a failure.

# v0.5.85 (2026-09-22)

## Features
- **System One**: add `/v1/systemone` decision endpoint for Jev models (OpenCode Zen and OpenRouter lanes), wire into sidebar and Media Providers page with interactive probe testing
- **CLI Tools**: add dynamic configuration, settings APIs, and official logos for Pi, OMP, Crush, ForgeCode, Smelt, and CodeWhale
- **Analytics & Usage**: add Requests mode, provider/model breakdown charts, All Time period filter, and refined overview cards
- **Combos**: add Cursor/Claude Default presets; support bulk select/delete and bulk strategy changes (Fallback / Round Robin / Fusion)
- **Model Capabilities**: expose model capability metadata on `/v1/models` and aggregate capabilities across combo targets
- **OpenCode Zen & MiMo**: add OpenCode Zen (`opencode-zen`) provider with free-tier fingerprint; switch default vision fallback to MiMo V2.6 Flash Free
- **Qoder CN**: add `qoder-cn` provider for qoder.com.cn with OAuth flow, COSY protocol, and CN gateway routing

## Fixes
- **Translator**: map Claude `refusal` stop_reason to `content_filter` and surface explanation; strip replayed reasoning fields for Groq, Mistral, and Cerebras (#4220)
- **Antigravity**: drop requestType `agent` to avoid false 429 `RESOURCE_EXHAUSTED`; separate weekly and short-window (5-hour) quotas and deduplicate dashboard rows
- **Responses API**: report usage on `response.completed` so clients can auto-compact (#3432)
- **Hugging Face**: migrate to Inference Providers router (`router.huggingface.co`), expand image models catalog, and add STT route
- **Qoder**: prevent signed request replay (`403/103 Duplicate request`), handle code 110 billing blocks, and preserve upstream SSE error status
- **Performance**: bound usage `lastUsed` scan to a 2-day window; map large budget tokens to `max` reasoning tier
- **Docker**: publish verified multi-platform images (linux/amd64 and linux/arm64) with configurable apk build mirrors

# v0.5.81 (2026-09-18)

## Features
- **Xiaomi MiMo**: merge MiMo Desktop support into `xiaomi-mimo` with dual auth (API key + Desktop/OAuth session), Preview models support, and encrypted-callback OAuth flow
- **Claude Code**: add 1M-context toggle (`[1m]` marker) and drive `CLAUDE_CODE_AUTO_COMPACT_WINDOW` directly from the dashboard
- **Models**: add DeepSeek-V4.1-Flash to DeepSeek provider, CodeBuddy-Intl, and Ollama (`deepseek-v4.1-flash:cloud`); enable `low`..`max` reasoning effort levels and vision capability for DeepSeek-V4.*
- **i18n**: integrate Persian (fa) translation

## Fixes
- **Cursor**: stop AgentService empty turns (`OUT 0`) and silent hangs — fold system prompts instead of `custom_system_prompt`, send `ModelDetails`, read Composer/Grok `thinking_delta`, ack request-context without echoing MCP tools, and reject IDE execs so the model can continue
- **RTK**: for Cursor, compress source-format `tool_result` / `role:tool` **before** translation — its translator rewrites those shapes, so post-translate compression missed them. Other providers keep the post-translate pass unchanged
- **OpenCode / OpenCode Go**: resolve 403 `FreeTierError` and 429 rate limits with canonical session format, valid User-Agent, and stable upstream session reuse; force stream and declare `forceStream` for free-tier SSE aggregation; cloak decoy tools, normalize Muse Free tool choice, and strip prior reasoning items on Responses models; route Union Alpha via Messages API
- **Kiro**: preserve underscores in tool names (`mcp__server__tool`) and restore client tool names in responses; use neutral placeholder for tool-result-only turns; forward tool-result images
- **Stream**: report aborts after HTTP 200 in-band (per-format error frames) instead of closing silently
- **Command Code**: preserve images and `reasoning_effort` on `/alpha/generate`; retry transient stream errors and avoid fake stop chunks; add Quota Tracker support
- **Zed**: harden OAuth lifecycle (preserve `systemId`, renew proxy timeout), support live model resolution, and lower display priority in OAuth list
- **Antigravity**: scope cached thought signatures to model family; strip Claude Code billing headers from system prompts; sanitize Hermes system identity
- **Codex**: route bare `codex-auto-review` requests to the Codex provider (#4135)
- **Auth**: do not cool down an account for request-scoped 4xx errors
- **Usage**: improve DeepSeek credit balance display as currency credit instead of 0/total quota bar
- **Model Catalog**: scope synced catalog to gateways and declare vision capabilities for DeepSeek V4.1-Flash IDs

# v0.5.76 (2026-09-16)

## Features
- **Database**: an instance can now run on an external Postgres instead of its local SQLite, which is what lets several of them share one database. Set `DATABASE_URL` and restart: the schema is created on boot and Settings reports **Distributed Mode** with the host, port, database and user — never the password or the raw URL. Leave it unset and nothing changes: SQLite under `DATA_DIR`, **Local Mode**, no configuration. Moving either way goes through the backup — download it, restart with (or without) the variable, then upload it again; both directions were exercised end to end
- **Database**: queries go through Kysely, so one query builder emits the right SQL for both engines rather than the codebase carrying SQLite-only statements. Indexes are declared structurally for the same reason: Postgres folds unquoted identifiers to lower case and has no `IFNULL`, so the raw DDL the schema used to carry only ever worked on SQLite
- **Auth**: per-user resource scoping, toggled from the SSO settings ("Restrict accounts and API keys per user"). Each account, API key and combo carries an `owner` — unowned resources stay shared with everyone, `@admin` keeps one to the password login, and an SSO user only sees, manages and routes through their own plus the shared ones. Admins see everything with the owner shown, and can reassign it. Turning the toggle off preserves every assignment: it only stops enforcing them
- **Auth**: designated admin e-mails (`ssoAdminEmails`) for SSO-only instances, where password login is unavailable and there would otherwise be no administrator. Admin is a session privilege, not an identity — an SSO admin keeps their own resources when the privilege is removed. Recovery stays with the CLI's "Reset Auth Mode to Password"
- **Combos**: combo names are now unique per owner, so two users can each keep a combo of the same name; a shared combo is usable by everyone but only an admin can edit it
- **Login**: SSO-only instances redirect straight to the identity provider instead of showing a single button (an `?error=` in the URL still shows the failure rather than looping)
- **Auth**: reassigning an owner reconciles API key bindings in both directions — a key whose owner can no longer reach an account is unbound from it, since bindings are consulted before ownership at request time. Only the unreachable bindings go: clearing the list entirely would read as "unrestricted" and widen the key instead
- **Auth**: an owner can be chosen when creating an account, API key or combo, and changed afterwards from the Edit dialog. The field is admin-only — for everyone else it is hidden and the server stamps their own identity, so an owner cannot be planted on someone else through the request body
- **Auth**: designated admin e-mails only apply while SSO is the only login. Switching back to password or both makes the password the admin again and leaves the list dormant rather than clearing it, so returning to SSO-only restores it
- **Auth**: filter accounts and API keys by owner on their dashboards (admins)
- **Auth**: a shared account stays with the admin to edit or delete, since either would affect everyone using it. A user may still switch one off for themselves — recorded per user, so the account stays active for the others, and it leaves that user's routing and model catalogue until they switch it back on
- **Token saver**: the token-saver flags (RTK, Headroom, Caveman, Ponytail) are per user. A key's owner gets their own settings where they set them and the admin's global ones everywhere else; a key with no owner, or an admin's, always follows the global config. The dashboard marks each inherited setting as `default` and offers "use default" to drop an override, so it is clear whose setting is in force
- **Token saver**: Headroom is infrastructure, so installing and starting it stays with the admin. A user can only switch on a Headroom the admin already set up — enforced server-side, not just hidden — and the row disappears entirely when nothing is installed, instead of offering a dead switch
- **Token saver**: clearer descriptions of what each switch does to a request, and a scoped user's PATCH no longer echoes the whole global configuration back
- **Settings**: the page is admin-only while scoping is on — it holds global configuration (auth mode, SSO, tunnel, database backup), not per-user preference. Language and theme stay in the header, reachable by everyone
- **Combos**: the combo page separates a user's own combos from the shared ones. A user cannot take a shared combo's name, but may hide that combo to free the name for their own; restoring it requires deleting theirs of the same name first
- **Headroom**: optionally send each API key's traffic to its own Headroom project (`/p/<key name>`), so per-project stats separate callers instead of pooling them; the key name is slugified and its value never reaches the proxy URL. Also exposes the existing `compress_user_messages` option in the dashboard
- **Auth**: reassigning an owner reconciles API key bindings in both directions — a key whose owner can no longer reach an account is unbound from it, since bindings are consulted before ownership at request time. Only the unreachable bindings go: clearing the list entirely would read as "unrestricted" and widen the key instead
- **Auth**: the owner of an API key is editable from its Edit dialog (admins, while scoping is on)
- **Auth**: designated admin e-mails only apply while SSO is the only login. Switching back to password or both makes the password the admin again and leaves the list dormant rather than clearing it, so returning to SSO-only restores it

## Fixes
- **Backup**: the database backup was missing `usageHistory`, `usageDaily`, `requestDetails` and any `kv` scope added after it was written — `disabledModels` and the per-user hidden combos among them. A restore therefore came back as a working system with its usage ledger erased and those preferences gone. It now exports every table and every scope, which is also what makes moving between databases safe
- **Security**: the translator's step 3 returned the outbound request with live credentials in it — `Authorization`, the provider's own bearer headers, a `?key=` in the URL and, for executors that embed it, the token inside the payload — so anyone who could open the dashboard could read an account's token. Values are now redacted while header names, URL and body structure stay, which is what the view is for; `/api/translator/send` rebuilds the real credentials server-side, so sending still works. Redaction matches both known header names and the credential values themselves, since a provider header like Kiro's `x-amz-sso-bearer` carries a token under a name no list would flag
- **Token saver**: RTK's last-resort truncation only fired above 250 *lines*, so a minified JSON payload or a wall of prose — one line however many KB — went upstream untouched. It now also triggers on size, which is what actually costs tokens
- **Token saver**: RTK and Headroom are coordinated instead of stacked. Both targeted tool output, RTK ran first, and whatever it rewrote reached Headroom already small, so the second pass paid latency for little gain. Each block now goes to one of them: RTK reshapes structured output (git, grep, ls, tree, logs) losslessly in-process, Headroom takes the unstructured text RTK cannot read. If Headroom does not deliver — timeout, proxy down — the deferred blocks are compressed by RTK rather than sent at full size, so coordination is never worse than either alone
- **Usage**: record the API key on request details — the Details tab showed "Local (no key)" for every request because the four `saveRequestDetail` call sites never passed it, while the usage history recorded it correctly
- **Usage**: keys issued by one instance share a machineId-derived prefix, so masking on the prefix alone collapsed them into one label and attributed requests to the wrong key; the masked form now keeps a distinguishing tail
- **Settings**: `PATCH /api/settings` requires admin while scoping is on — any logged-in user could otherwise turn off their own restriction, or change auth mode, SSO config and `requireApiKey`
- **Headroom**: open the panel on remote instances. `/api/headroom/proxy` was grouped with the process-spawning `start`/`stop` routes as local-only, so it answered "Local only: CLI token required" wherever the peer was not loopback; it only forwards HTTP and already drops cookies and credentials for non-loopback targets
- **Dashboard**: fix the API key list running its name, creation date and bindings together (the date is now a small label beside the name), and drop the 9Remote and 9English sidebar entries

# v0.5.75 (2026-09-10)

## Features
- **Video**: add OpenRouter and Vertex AI (Veo) video generation on `/v1/videos/*` via a provider adapter layer; poll requests resolve their provider from `x-connection-id` or `?provider=`
- **Antigravity**: add weekly quota tracking (Gemini weekly / Claude & GPT weekly) and free-tier handling from `retrieveUserQuotaSummary` (#3892)
- **Codex**: add GPT Image 2.5, Flare and Sunburst image models with multi-image support; add the same ids to the OpenAI catalog
- **Qoder**: surface usage to all clients and stop inlining large attachments — images upload through `/api/v2/image/upload` like qodercli, oversized file blocks become stubs, context tier auto-escalates
- **OpenCode Go**: add newly published models (glm-5.3, kimi-k3, deepseek-flash, longcat-2.0, hy4-preview, hy3 on chat/completions; qwen3.8-max, qwen3.8-flash on `/messages`; grok-4.6, gpt-5.6-luna on Responses) and list `deepseek-v4.1-flash` first in the catalog
- **CLI tools**: group the model selector by provider with full-text search and manual custom model ID entry
- **CodeBuddy-CN**: replace `deepseek-v4-flash` with `deepseek-v4.1-flash`

## Fixes
- **Tools**: scope Claude tool type defaulting to gateways declaring `requireClaudeToolType` — the global default broke Anthropic-compatible endpoints that only accept the legacy typeless tool shape (#3905)
- **Claude**: cap re-anchored `cache_control` at the 4-marker budget so a spent budget no longer 400s and triggers a full combo failover; wrap bare single-object content turns before the mid-conversation-system fold
- **Cline / Airforce**: unwrap the `{"success":true,"data":…}` envelope on non-stream chat completions (#3644); add the live Cline/ClinePass model catalog and refresh Airforce free models
- **Cline**: stop `workos:`-prefixing ClinePass API keys (401 on every request, #2333) and add clinepass token refresh
- **Kiro**: never send a top-level `systemPrompt` (`400 REQUEST_BODY_INVALID`); route requests through current runtime surfaces (#3776)
- **Codex**: strip Unicode-property tool schema patterns the validator rejects (#3922); restore the `Version` header and single-source the CLI version
- **DeepSeek**: keep Anthropic-only tool types when forwarding to `/anthropic/v1/messages`
- **Qoder**: drop the Responses usage plumbing from shared translator/handler code, which changed token accounting for every provider, not just Qoder
- **Antigravity**: normalize contents and handle intermediate tool responses; protect the OAuth token-refresh path from Google anti-abuse rate limits (#3813)
- **Providers**: clear stale connection health state (`modelLock_*`, `backoffLevel`, `rateLimitedUntil`, `errorCode`) when a connection is re-validated (#3810, #3830); remove the duplicate `qwen` provider that shadowed `alims-intl`
- **Video / Vertex**: reject job ids and model ids that would escape the request URL path (SSRF)
- **Usage**: parse the Fable weekly limit from `limits[]` instead of fabricating a row (#3847)
- **Auth**: set a 24h `maxAge` on the dashboard session cookie

# v0.5.69 (2026-09-05)

## Features
- **Codex**: add GPT 6.0 Astra (`gpt-6-astra`) with vision, thinking and search capabilities
- **Usage**: add Claude Fable quota tracker support with weekly window normalization (`weekly fable (7d)`)
- **Dashboard**: group Antigravity Gemini and Claude quotas in Quota Tracker, prune stale hidden keys
- **OpenCode Go**: add `muse-spark-1.3-contributor` model and support parallel tool calls on Responses path (#3819)
- **Providers & Models**: align CodeBuddy-CN catalog/capabilities with server config; add GPT-5.6 Sol, Terra, Luna image aliases on Codex (#3806); refresh Qoder catalog with capability mapping and image pass-through
- **CLI tools**: replace Copilot MITM with VS Code extension setup guide
- **Gemini**: persist and replay `thoughtSignature` scoped by session namespace

## Fixes
- **Claude**: normalize adaptive auto effort (`output_config.effort`) (#3792)
- **Antigravity**: prevent Google anti-abuse rate limits during multi-account refresh (#3813)
- **Anthropic-compatible**: forward Claude beta flags to nodes fronting Anthropic (#3797)
- **Dashboard**: dynamic mode label for local/remote detection (#3801)
- **Codex**: format reset credit API errors cleanly (#3778)
- **Security**: guard cowork MCP tools probe against SSRF (#3783)
- **OpenCode Go**: track OpenCode Go quota (#3791) and send stable session headers (#3800)
- **Logger**: suppress noisy background token refresh logs
- **CLI**: export packed `.tgz` directly into workspace root instead of parent directory

# v0.5.65 (2026-09-03)

## Features
- **Fetch**: add Ollama Cloud web fetch provider
- **Gemini / Antigravity**: add Gemini 3.8 Flash support and bump IDE fingerprint to 2.11.0
- **Claude**: add Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bump Claude Code fingerprint to 2.1.258 for new-model access
- **Providers**: add client-side status filter (All / Active / Inactive / No connection) on the Providers dashboard; add max height and scroll for connection list
- **Providers & Models**: streamline tokenrouter model catalog down to 22 flagship/newest models and add missing provider icons; refresh Codebuddy-CN catalog (add hy4-preview/hy3/glm-5.3/kimi-k3-1, drop EOL glm-5.0/glm-4.7)
- **Models**: capability toggles (vision, reasoning) when adding custom models with upsert and live caps refresh
- **CLI tools**: support saving and managing custom API key presets
- **Quota**: add usage and rate-limit tracking for Groq via `x-ratelimit-*` headers
- **i18n**: complete Indonesian translation (1391 keys)

## Fixes
- **Security**: close SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714)
- **Model markers**: strip the `[1m]` context marker Claude Code appends to model names (`claude-opus-5[1m]`) preventing model resolution failures (#3690)
- **Claude**: drop `server_tool_use` blocks carrying foreign IDs to avoid Anthropic 400 rejections; never anchor cache breakpoints on `defer_loading` tools (#3567)
- **Antigravity**: strike-break optimistic quota readings that keep 429ing by blocking the connection+model pair for 15m after 3 strikes (#3681); preserve client identity on model catalog requests (#3414)
- **Auth**: protect root `/responses` rewrite requiring API key validation in dashboardGuard
- **Chat & Docker**: return 503 Service Unavailable when all credentials are rate-limited; explicitly bundle `node-machine-id` into standalone Docker runtime image
- **OpenCode**: route Muse Spark models to `/zen/v1/responses` and declare vision support; filter inactive free model
- **Kiro**: preserve inline images as OpenAI-compatible `image_url` parts in OpenAI MITM; remove redundant top-level `systemPrompt` from payload
- **Usage**: read Responses-shape `cached_tokens` in `extractUsageFromResponse` for non-streaming traffic
- **Models**: support single model lookup with provider-prefixed IDs (e.g. `cc/claude-sonnet-5`)
- **Translator**: route Gemini thinking through `reasoning_effort` on OpenAI-compatible wire; convert `prefixItems` and ensure array items in Gemini schema sanitizer
- **UI**: apply persisted theme before first paint to prevent flash on reload; translate combo vision adapter label

# v0.5.59 (2026-08-29)

## Features
- **Search**: new web search providers — Antigravity (Google Search grounding
  on the existing OAuth account pool, citations keyed and merged by URL) and
  Xquik (X search with `x-api-key` auth, cursor pagination, credit-based
  usage), both on `POST /v1/search`. Based on #3437 by @Nautilaceae
- **Search**: ollama-search and zai-search borrow a chat provider's API key
  instead of requiring their own connection, driven by a new
  `credentialFallback` registry field. zai-search later folded into the `glm`
  provider itself so the web search page shows the shared connection
- **Models**: daily background sync of model capabilities from models.dev —
  modalities keyed by model id (majority of sources must declare one),
  context/output limits keyed by provider + model, strictly additive and
  sitting below the hand-written tables. ETag + mtime cache, 60s startup
  delay, `MODEL_CATALOG_SYNC=off` to disable
- **Models**: add GLM-5.3-Flash (1M context, natively multimodal), DeepSeek
  V4 Vision, Grok 4.5/4.6 (500k context); correct glm-4.6v/4.5v video input
  and output limits, backfill glm-4.6v on glm-cn
- **Usage**: show the Zed plan quota on the dashboard — plan, edit
  predictions, hosted model requests and billing-cycle reset; unlimited rows
  render as "N used · Unlimited"
- **Usage**: track GPT-5.3-Codex-Spark quota windows (spark_session /
  spark_weekly) from the Codex usage response (#3431)
- **Antigravity**: quota-aware routing — on 409/429 fetch live quota for the
  exact per-model resetAt and skip only the exhausted account/model pair;
  report the earliest reset when every account is blocked (#3561)
- **Antigravity**: map image `size` to the aspect-ratio model suffix (-WxH);
  add the Gemini 3.7 Flash tiers to MITM defaultModels so they show up in
  the dashboard model-mapping table
- **Dashboard**: bulk import Grok CLI accounts from JSON — paste an array or
  drag-drop multiple .json files, all OAuth connections created in a single
  call, mirroring the codex flow
- **CLI tools**: endpoint presets shared across every tool card through one
  live-resyncing store, instead of per-card localStorage copies that never
  saw each other's saved endpoints
- **Token Saver**: configurable compression timeout (`headroomTimeoutMs`) —
  the fixed 3000 ms made busy machines time out and send inconsistently
  compressed bodies, hurting prompt caching
- **i18n**: pt-BR expanded to 1132 terms

## Fixes
- **Claude Code**: add Claude Fable 5.1 and advertise Claude Code 2.1.258 in
  both the request header and billing identity; use its permanent adaptive-thinking
  mode with `output_config.effort`
- **Stream**: record usage when a client closes on the terminal event — the
  Responses API has no [DONE] sentinel, so codex closed the socket on
  `response.completed` and cancelled the reader before flush() ran its usage
  side effects; the tail now lives in a once-guarded finalizeStream(). Also
  stop logging a disconnect for every completed Responses call
- **Stream**: parse the trailing NDJSON line an Ollama stream leaves behind
  without a closing newline — the final chunk carrying `done_reason` and the
  token counts was dropped
- **Session**: read the Claude Code session id from the
  `x-claude-code-session-id` header — `metadata.user_id` is dropped by
  Responses translation, splitting one conversation across several
  `prompt_cache_key` values and missing the upstream prefix cache
- **Usage**: preserve nested `cached_tokens` — the top-level-only read
  persisted `cached_tokens: 0` for every Responses-format provider (codex,
  grok-cli, …), billing cache hits at the full input rate
- **Usage**: GLM quotas accept CREDIT_LIMIT plans and multi-interval windows
  (5h session / 7d weekly) instead of overwriting a single "session" key
- **Models**: the catalog sync no longer erases its own output — deltas were
  measured against the previous run's writes (the second run cut `providers`
  from 20 entries to 5); one vote per provider in the modality tally, ETag
  restored from file on startup, and the worker thread dropped after the
  bundler rewrote its path into a module-not-found error
- **Executor**: CommandCode returns errors as a `type:"error"` event inside
  an HTTP 200 NDJSON stream — peek the first events before committing, abort
  and return a real 4xx/5xx so combo/account fallback triggers instead of
  streaming the error text as content
- **Search**: scope failure locks on the credential-fallback path — a failing
  search locked `modelLock___all` and took the shared glm key offline for
  chat as well; locks are now attributed to the connection's owner and
  scoped to `websearch:<provider>`
- **Providers**: connection tests get a 15s AbortSignal timeout instead of
  hanging and exhausting the browser socket pool; guard undefined provider
  names on the providers page
- **Antigravity**: sanitize competing-client branding via a config-driven
  rule table (Zed's Claude-agent prompt, opencode → antigravity) — upstream
  answers 429 Quota Exhausted. Applied in the executor so the shared
  openai-to-gemini translator leaves gemini/vertex/zed untouched
- **MiniMax**: preserve images on the sourceFormat-matched OpenAI transport
  — MiniMax-M3 resolved a Claude-shaped body posted to the OpenAI endpoint,
  silently dropping `image_url` blocks (#3418)
- **Claude**: decloak tool names in same-format streaming passthrough —
  OAuth-cloaked names (CLAUDE_TOOL_SUFFIX) leaked to the client and every
  tool call was rejected as unknown
- **Tools**: default a missing `tools[].type` to "custom" on Claude-format
  requests — strict Anthropic-compatible gateways (MiniMax) reject the
  request with 400 otherwise
- **Translator**: zai thinkingFormat sends the top-level `reasoning_effort`
  object GLM-5.2+ requires — every GLM-5.x request ran at the model default
  (max); gated on GLM-5.2+ since older GLM does not read it (#2721)
- **RTK**: system prompt injection matches each target wire format
  (Chat/Responses/Claude/Gemini/Kiro) and is exact-idempotent across retries,
  so distinct prompts sharing a long prefix are no longer collapsed (#3202).
  Also set the diagnostic before the silent null return on Responses
  translation failure so the panel is no longer blank
- **OpenCode**: route muse-spark through /zen/v1/responses (it 500s on
  chat/completions), normalizing the Chat fields the Responses API rejects
  and clamping max/ultra effort to xhigh
- **CLI**: install better-sqlite3 without build tools on Node 22+ (N-API
  13.0.3 ships per-platform prebuilds, `--ignore-scripts` skips the implicit
  node-gyp build); Node < 22 stays on 12.6.2, working installs untouched
- **CLI tools**: send the API key Codex actually reads —
  `[model_providers.9router.http_headers]` instead of auth.json (which left
  every request 401 and clobbered an existing ChatGPT login); subagent model
  moved to `agents.default_subagent_model`
- **OAuth**: refresh Cline tokens with the extension JSON contract
- **Dashboard**: clamp the API key mask length — keys shorter than 8 chars
  threw RangeError and crashed the media-provider detail page
- **UI**: wait for the Material Symbols font itself before revealing icons —
  `document.fonts.ready` resolved before the 4MB woff2 even started loading,
  leaving icons blank until a second load

# v0.5.55 (2026-08-14)

## Features
- **Auth**: native SAML 2.0 SSO alongside OIDC — AuthnRequest generation, ACS
  assertion handling, SP metadata export, admin config test, replay-protected
  via a `saml_state` cookie matched against `InResponseTo`
- **Providers**: add Alibaba Token Plan (`token-plan.ap-southeast-1`) — the
  fourth Alibaba key type, Singapore-only and OpenAI-compatible transport only
- **Providers**: add `glm-5.3` to GLM Coding and GLM (China)
- **Providers**: Kimchi accepts API keys as well as OAuth (dual auth), with a
  working Test Connection for both modes
- **Antigravity**: add Gemini 3.7 Flash and its tiered high/medium/low variants
  (also in the Gemini registry) with pricing and quota tracking
- **TTS**: add Fish Audio — model id travels in an HTTP `model` header, voice
  is a `reference_id` (preset or cloned voice model)
- **OpenCode-Go**: route by request format via declared transports instead of
  forcing every client into `/messages` — Codex/OpenAI clients no longer pay a
  lossy Responses→OpenAI→Claude double translation. Per-model `supportedFormats`
  guard; the bespoke executor is gone (its shared `_lastModel` cache could cross
  auth headers between concurrent requests)
- **Usage**: dedup + cache Claude quota calls (120s TTL keyed by access token,
  in-flight promise dedup, last-good read on soft failure) to stop multiple
  tabs tripping 429; manual refresh (↻) sends `force=1` to bypass the cache

## Fixes
- **Docker**: ship `sql.js` in the image so the pure-JS DB fallback can start —
  file tracing carried the package's JS without `dist/sql-wasm.wasm`, so a
  container with no native driver aborted with ENOENT and never got a database
  (#3248)
- **Usage**: read Gemini `usageMetadata` out of the antigravity `{ response }`
  envelope — every non-streaming antigravity request logged `IN 0 | OUT 0`
  (#3260)
- **Claude**: re-anchor passthrough cache breakpoints — the client's own
  `cache_control` markers point at pre-normalization offsets, so the tail was
  re-cached every request. Last system block and last tool pinned at 1h TTL,
  last assistant turn at 5m, mid-conversation system messages folded into the
  neighbouring user turn instead of hoisted into `body.system`
- **Combos**: detect images from Hermes and attachment payloads (`images[]`,
  `experimental_attachments`, message-level `image_url`/`audio_url`, inline
  `data:` URIs) so the Vision Adapter auto-switch fires for Hermes/Ollama/
  Vercel AI SDK shapes
- **Kiro**: intercept chat via `x-amz-target` — Kiro IDE 1.0.228+ moved
  `GenerateAssistantResponse` to `POST /` + header, bypassing MITM. Also emit
  the now-mandatory initial-response frame and map the `auto` model slot
- **Kiro**: report real output tokens and stop discarding usable turns
- **Qoder**: detect billing blocks at stream start and return a synthetic 403
  so combo/account fallback triggers instead of leaking the error into chat
- **Antigravity**: strip competitive system prompts (Zed IDE's Claude-agent
  prompt) that Antigravity flags with a 429 Quota Exhausted
- **OpenCode**: send the official client fingerprint on free-tier requests so
  the Console stops classifying traffic as unidentified and rate-limiting it;
  session id resolves conversation-stable to preserve prompt caching
- **Responses**: don't close the message on an empty `tool_calls` array — some
  providers attach one to every chunk, and the truthy check ended the message
  on the first content token (#3234)
- **Translator**: preserve `prompt_cache_key` when converting chat to responses
- **Models**: expose snake_case token limits on `/v1/models`
- **Combos**: strip `stream_options` from the Fusion panel fan-out to avoid a
  DeepSeek 400 (#3024); raise the dashboard model-test probe budget to 1024 and
  soft-pass reasoning-only responses (#3010)
- **Headroom**: the toggle reflects the `headroomEnabled` setting even when the
  proxy is down — it previously showed OFF while the engine kept calling
  `/v1/compress`; proxy status stays visible via the status chip
- **Hermes**: add the `api_key` parameter to the model block in YAML config
- **Providers**: add llm7 to provider test support

## Docs
- **i18n**: add Spanish, French, and Brazilian Portuguese README translations

## Security
- **Real IP**: `x-9r-real-ip` and the Host fallback were trusted from
  client-controlled headers whenever `custom-server.js` was not in the request
  path (`npm run start`, `start:bun`), letting a remote caller pose as local to
  skip API key auth and reach `LOCAL_ONLY_PATHS` (`/api/mcp/*`,
  `/api/tunnel/enable`, `/api/auth/reset-password`). The server now stamps a
  per-process `x-9r-peer-token` on every request it sanitizes and only trusts
  `x-9r-real-ip` behind it — falling back to Host in development and failing
  closed in production (GHSA-pjm4-8fpg-f9p6). Also fixes IPv6 loopback
  detection (`::1`, `::ffff:127.0.0.1`) and routes `npm run start` /
  `start:bun` through `custom-server.js`
- **Search**: `resolveBaseUrl()` rejects client-supplied non-public baseUrls
  (SSRF guard on `/v1/search`)
- **Login**: fresh-install remote login with the default password returns 403
  without issuing a JWT
- **Usage**: `/api/usage/request-details` redacts request/response payloads

# v0.5.50 (2026-08-05)

## Features
- **Providers**: add TokenRouter (300+ models via OpenAI-compatible gateway) with
  exact per-model pricing for 110 models and `reasoning_effort` thinking config
- **Providers**: add Self-hosted STT / TTS / Embedding — point 9Router at your own
  OpenAI-compatible speech and embedding servers (whisper.cpp, faster-whisper,
  Kokoro-FastAPI, llama-server, vLLM, Infinity). Unlike the named cloud providers
  these read `baseUrl` per connection, so one provider can front several machines
- **Combos**: default-enable vision/audio capacity adapter (auto-routes to a
  vision/audio-capable model when the target lacks that capability, falling back
  to `oc/mimo-v2.5-free`), wired into chat handler routing
- **Endpoint**: auto-provision a "Default Key" for first-time users so `/v1`
  works without a manual dashboard step
- **Codex**: support GPT-5.6 Max/Ultra reasoning-level overrides (cx/ routes only)
- **Qoder**: support PAT (Personal Access Token) connections end-to-end, alongside
  OAuth device flow
- **CLI tools**: add OpenDesign (manalkaff/opendesign) support
- **Headroom**: report effective payload savings (tool schema/history bytes broken
  out, byte-savings % reflects actual outbound reduction)
- **Ollama**: Cloud quota tracker (session + weekly) + proactive background OAuth
  token refresh scheduler for all providers

## Fixes
- **Providers**: remove Qwen (OAuth flow stopped working reliably)
- **Passthrough**: detect codex-tui/Codex Desktop as native Codex client — they
  were falling through to the translator and losing fields like `reasoning.summary`
- **OAuth**: scope antigravity header fixes to loadCodeAssist/onboardUser only
- **OAuth**: keep `open` external in the build so xAI/Grok token refresh works on
  Windows
- **OAuth**: declare missing `searchParams` in register-session handler (was a
  500 instead of JSON on error)
- **DB**: `ENABLE_REQUEST_LOGS` env var now overrides the UI setting correctly;
  observability defaults to off (opt-in)
- **Translator**: preserve Codex Responses Lite tool use across chat-native
  OpenAI-compatible providers
- **Translator**: don't drop image-only user messages in `prepareClaudeRequest`
- **Translator**: drop JSON Schema keywords Gemini rejects (`uniqueItems`,
  `contains`, `multipleOf`, `unevaluatedProperties`, `unevaluatedItems`,
  `contentSchema`)
- **Claude**: remove global header cache that leaked one client's identity
  headers onto another client/account sharing the server; gate `anthropic-beta`
  by model instead
- **Antigravity**: drop retired Gemini 3.0 quota tiers, show Gemini 3.6 Flash
  usage bars
- **Cloudflare AI**: declare API key authentication (dashboard showed "No
  connections" despite an active key)
- **GitHub Copilot**: hold monthly-exhausted accounts until UTC month reset
  instead of only cooling down 120s
- **CodeBuddy**: dodge Tencent CN content filter, add usage tracking, normalize
  codebuddy-intl messages
- **Usage**: stop losing cached prompt tokens in the forced-SSE→JSON path
- **Grok CLI**: display the public subscription tier from the OAuth token claim
- **Providers**: count apikey connections for Ollama free-tier card; free-tier/
  apikey providers without `authModes` now default to apikey (were treated
  oauth-only)
- **Build**: include static/public assets in standalone output (login page hung
  on 404s when run via PM2)
- **Server**: support IntelliJ IDEA OpenAI-compatible clients over HTTP (h2c
  upgrade handling)
- **Auth**: redirect already-logged-in sessions away from `/login`
- **CLI tools**: enable Apply button for dynamic OpenAI/Anthropic-compatible
  provider connections
- **CLI**: include complete API artifacts in the CLI package
- **TTS**: a bare self-hosted model name is the MODEL, not the voice — `kokoro`
  was parsed as a voice against a default model, 404ing or synthesising with the
  wrong one
- **Embeddings**: self-hosted embeddings no longer fall back to `api.openai.com`
  when a connection has no `baseUrl` — that silently sent the input text and API
  key to OpenAI under a provider named "Self-hosted"
- **Embeddings**: an adapter that rejects a misconfigured connection now returns
  400 with the reason instead of escaping the handler uncaught
- **Embeddings**: bound the upstream fetch with `FETCH_CONNECT_TIMEOUT_MS` — an
  endpoint that drops packets never returns headers, so the request previously
  hung indefinitely

## Docs
- **i18n**: fix port typo, add RTK Token Saver feature descriptions

# v0.5.45 (2026-07-30)

## Features
- **TTS**: add Xiaomi MiMo text-to-speech (preset voices 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean, style control, language hint dropdown with Auto-detect, i18n for Style label/placeholder)
- **Providers**: add Poolside (OpenAI-compatible)
- **Providers**: add api-airforce, baidu, bazaarlink, bluesminds, kilo-gateway, llm7, morph, sambanova, tencent
- **OAuth**: zed / trae / windsurf providers + harden callback proxies
- **CLI tools**: set Claude Code max context tokens
- **Qoder**: PAT auth + refresh model list
- **Gemini**: Gemini 3.6 Flash tier routing + Gemini 3.5 Flash Lite
- **Claude**: bump default Opus to `claude-opus-5`
- **Kiro**: add Claude Opus 5 models
- **Usage**: Kimi and DeepSeek usage handlers
- **Usage**: SuperGrok weekly pool via gRPC-web

## Fixes
- **Refresh**: rotate `refresh_token` between retry attempts
- **Kiro**: canonicalize tool history and route API keys correctly
- **Kiro**: normalize dashboard thinking intensity models
- **Cursor**: stop leaking agent tool errors as text
- **Gemini**: fill empty tool schemas after `$ref` strip
- **Antigravity**: strip `stream_options` from non-stream requests
- **Jina-reader**: recover after transient errors, use JSON POST API
- **Usage**: record exact embedding tokens
- **Tunnel**: preserve successor cloudflared PID
- **Console-log**: initialize capture at server boot + prevent SSE proxy buffering
- **Dashboard**: count dual-auth, free-tier OAuth and API-key connections correctly
- **Dashboard**: flex quota rows, thin global scrollbars, no hidden-row overflow

## Docs
- **i18n**: expand pt-BR translation to 986 terms
- README: Indonesian translation

# v0.5.40 (2026-07-20)

## Features
- **i18n**: add Khmer (km) translations
- **CLI tools**: configure Grok Build subagent models
- **Kimi**: merge OAuth into dual-auth provider, add K3 / K2.7 models
- **Dashboard**: ProviderTopology flow animation

## Fixes
- **DB**: resolve better-sqlite3 parameter binding crash
- **Translator**: pass `service_tier` through OpenAI → Responses conversion
- **Kiro**: map GPT-5.6 reasoning effort fields
- **Kiro**: validate terminal streams before emitting output
- **Kiro**: map GPT reasoning effort fields
- **Codex**: current `client_version` + refresh-aware model sync
- **Alicode-intl**: split into Coding Plan + Model Studio providers
- **Cursor**: HTTP/2 AgentService support + version bump 3.12.17
- **Dashboard**: cut duplicate API/icon spam, lazy-load provider assets


# v0.5.35 (2026-07-16)

## Features
- **xAI**: Grok Imagine video generation (`/v1/videos`) + CLI
- **CLI tools**: Grok Build setup — choose separate main/general-purpose/explore/plan models and preserve each model's context window
- **GitHub Copilot**: route Claude models through Copilot's native `/v1/messages`
- **Kiro**: add GPT-5.6 model family (#2596)
- **RTK**: `X-9Router-Token-Saver` header to bypass token savers per request
- **Providers**: quota visibility settings
- **Translator**: drop temperature for all Claude models
- **i18n**: Thai (th) + Persian (fa) translations / README

## Fixes
- **Providers**: bulk-add API keys no longer overwrite existing keys (gap-fill `Key N`)
- **Anthropic**: lowercase `anthropic-version` header to prevent duplication on `/v1/messages`
- **Alicode-intl**: use DashScope compatible-mode endpoint so standard keys work
- **Grok CLI**: align Grok Build with current subscription protocol (#2590)
- **Grok CLI**: surface `expiresAt` so proactive token refresh fires (#2546)
- **Kiro**: improve direct session cache reuse
- **Models**: populate capabilities for live-catalog LLM models
- **Models**: list compatible provider models in `/v1/models`
- **Thinking**: send explicit `thinking:{type:adaptive}` alongside `output_config.effort`
- **Translator**: strip `client_metadata` when converting openai-responses → openai

## Improvements
- **Perf**: skip inactive background services on startup

## Docs
- README: Persian YouTube tutorial

# v0.5.30 (2026-07-10)

## Features
- **Perplexity**: add Agent API provider (#2492)
- **Grok CLI**: add Grok CLI / Grok Build provider with OAuth device-code flow (#2502)
- **Featherless**: add OpenAI-compatible provider presets
- **SearXNG**: configure endpoint via SEARXNG_URL env (#2499)
- **Providers**: add max thinking level for gpt-5.6-sol (#2500)
- **Headroom**: add extras detection and install UI (#2403)
- **Headroom**: activate/uninstall extras + fix interpreter detection
- **PXPipe**: PXPIPE token saver — multimodal prompt compression (#2465)
- **Proxy-Pools**: auto-rotate strategy for no-auth providers (#2409)

## Fixes
- **Cloudflare-AI**: support accountId in bulk key import (#2449)
- **DB**: backup on schema change, MCP child cleanup, codex models, usage providers OOM
- **Codex**: avoid bare-email OAuth dedup (#2477)
- **CLI**: allow staged app bundle builds (#2479)
- **Headroom**: compress Kiro conversation state (#2488)
- **Gemini-CLI**: raise output floor for thinking and add validated toolConfig (#2486)
- **GitHub**: label Copilot profiles by account identity (#2498)
- **OpenAI-to-Claude**: unwrap bare {function:{…}} tools without parent type (#2473)
- **Translator**: clamp thinking effort max->xhigh for OpenAI format (#2466)
- **RTK/find**: detect and group Windows backslash-style find output (#2448)
- **Codex**: handle fast tier and capacity SSE (#2452)
- **Volcengine-ark**: clamp Kimi max_tokens to 32768 endpoint cap
- **Antigravity**: align provider fingerprint with IDE Desktop 2.1.1 (#2389)
- **Pricing**: update Claude/Codex model rates and add new models

## Improvements
- **i18n(zh-CN)**: complete Chinese translations for all UI strings (#2436)
- **API**: caching for tunnel and version status endpoints
- **Perf**: faster dev startup and lighter bundle

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

## Features
- **Usage**: track cached tokens + correct input/output/cache cost (#2209) — hodtien
- **Codex**: show reset credit expiry details (#2290) — Rafli Ahmad Zulfikar
- **NVIDIA**: add new models and capabilities — decolua
- **ClinePass**: add provider support — sternelee

## Fixes
- **Usage**: dedupe streaming request-details log entries — Qin Li
- **Claude**: drop foreign thinking signatures in passthrough — decolua
- Prevent non-SSE stream pipe crash and cross-IdP account overwrites (#2244) — KunN-21
- **Kiro**: route IdC auth to regional CodeWhisperer surface (#2297) — Volodymyr Saakian
- **Kiro**: add Claude Sonnet 5 model support (#2264) — Edison42
- **Xiaomi-tokenplan**: region selector, key validation, multi-connection (#2251) — MiQieR
- **Translator**: strict Anthropic content block compliance (#2225) — Sahrul Ramadhan Hardiansyah
- **Kimchi**: strip reasoning_content echo to bound multi-turn input tokens — KunN-21
- **Kimchi**: bump User-Agent to kimchi/0.1.40 (#2256) — Ansh7473
- **Codebuddy-cn**: strip empty tool_calls arrays to preserve reasoning — zmf
- **Antigravity**: preserve Claude tool delta index (#2223) — Sutarto Jordan Chrisfivo
- **MITM**: generate root CA on server startup (#2228) — Sutarto Jordan Chrisfivo

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns — decolua
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai) — decolua
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM — decolua

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL
