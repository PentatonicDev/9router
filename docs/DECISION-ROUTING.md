# Small-model routing for coding agents: the option set and the premise decide, not the gate

Three findings, each arrived at by a measurement that broke a comfortable result:
the pool must not contain near-duplicates (§2); the state the router is asked over
must keep the turn that says what the work *is* (§2.1); and when the router
abstains on a step that needs thought, the fallback must not be the cheapest model
(§8.2). None is a threshold you can tune, and none is visible in a confidence score.

On the one task where the cheap model measurably fails (§8.2), the routed combo
matched the fixed strong model at 3/3 for 64% less. That is n=3 on one task: it
shows the policy *can* preserve quality where it matters, not that it does in
general.

A System One model (jev, ~3k input tokens per call, $0.042/M) decides which model
of a pool serves each turn of a real coding agent, how far a tool verdict may go,
and how much reasoning budget a mechanical turn gets. This document records what
was measured, how, and which claims the measurements do *not* support.

Measurements below combine live provider calls with explicitly labelled
synthetic conversation probes and local regression tests, all run on 2026-09-23.
Only the Claude Code A/B runs used real agent trajectories; no full decision state
was captured for the 43 routed turns of §1, though §8.2's verdicts were recorded.

## 1. The result, and the bug that raising N exposed

Paired A/B through Claude Code against a running 9Router. Identical harness, three
coding tasks, each with a check that fails before the work and passes after.

At n=3 per arm the routed arm looked like a free lunch: same 2/3 pass rate,
$1.57339 → $0.16615, −89.4%. At n=9 the pass rate moved and the picture changed:

| arm | model asked for | pass | 95% CI | chat | decision | total | $/solved |
|---|---|---|---|---|---|---|---|
| control | `kr/claude-sonnet-5` (fixed) | 8/9 | 56–98% | $5.64728 | — | $5.64728 | $0.70591 |
| routed (buggy) | `coding-auto` (combo, enforce) | 6/9 | 35–88% | $0.50395 | $0.00547 | $0.50943 | $0.08490 |

The routed arm served **43 of 43 turns on haiku** and failed all three repeats of
the one task the control arm passed twice. That discrepancy prompted an audit of
the decision state, which found a reproducible truncation defect (§2.1). Because
production decision states were not recorded, the experiment does not show that
the defect caused the 43 haiku selections or the pass-rate gap.

**The honest status of the cost number.** −91% was measured before the state fix;
all 43 requests were served by haiku. It is an observed cost for that run, not
evidence that a router protects quality or the cost of an optimal policy.
Section 8.1 records the re-measurement after the fix: 7/9 at −91.6%; one
previously failing repeat passed, but independent stochastic runs cannot
attribute that improvement to the fix. `bench-report.mjs` prints the
interval-overlap caveat next to every ratio rather than letting it stand alone.

## 2. The finding that mattered: pool shape

The pool the decision model is asked over determines verdict quality far more than
where the acceptance gate sits.

Kiro exposes 44 models, of which the Claude family appears as 4 near-identical
variants per capability tier (`-thinking`, `-agentic`, `-thinking-agentic`, plus
the base). Asking one Choice question over 12 such variants:

| task | pick | winner strength | above 0.60 gate |
|---|---|---|---|
| mechanical_rename | haiku-4.5 | 0.93 | yes |
| small_bug | haiku-4.5-thinking | 0.43 | no |
| impl_spec | sonnet-5 | 0.33 | no |
| architecture | opus-5-thinking-agentic | 0.36 | no |
| race_debug | sonnet-5-thinking | 0.61 | yes |
| format_only | haiku-4.5 | 0.38 | no |

2 of 6 cleared the gate. The variants are not wrong answers — they are the *same*
answer spelled four ways, and they split the probability mass between themselves.

Collapsing to 3 capability bases and asking the same six states, twice each:

| task | tier | expected | strength (run 1 / run 2) | deliberation |
|---|---|---|---|---|
| mechanical_rename | haiku | haiku | 1.00 / 1.00 | 0.16 |
| small_bug | haiku | haiku | 0.58 / 0.64 | 0.31 |
| impl_spec | sonnet | sonnet | 0.95 / 0.95 | 0.37 |
| architecture | opus | opus | 0.91 / 0.91 | 0.96 |
| race_debug | opus | opus | 0.31 / 0.40 | 0.82 |
| format_only | haiku | haiku | 1.00 / 1.00 | 0.26 |

**6/6 correct tier, mean winner strength 0.805** (against a mean well under the
gate for the flat pool), 9 of 12 above 0.60, and the picks were stable across
repeats. This is why `decisionCandidates()` collapses variants to one base per
family before building the question and keeps the variants as fallbacks.

The collapse is provider-scoped on purpose, and price is the evidence. Queried
against the pricing tables: `kiro/claude-sonnet-5` and
`kiro/claude-sonnet-5-thinking` both resolve to $3.00/M — one upstream model, a
synthetic suffix. `moonshot/kimi-k2` resolves to $1.00/M and
`moonshot/kimi-k2-thinking` to $1.50/M — two distinct models, where collapsing
would silently drop a real option. So the regex is gated on the Kiro alias rather
than applied to every `-thinking` it sees.

### 2.1 The defect: truncation ate the premise

The state sent to the decision model is built by walking the conversation
newest-first until a character budget runs out. That is the right instinct for a
chat completion and the wrong one for a routing question, because the **first**
user turn is the only turn that says what the work *is*, and newest-first makes it
the first thing dropped.

Measured on a 40-iteration agent loop (one statement, then tool traffic):

```
turns in window: 66 of 81   omitted: 15
first kept turn role: assistant
task statement survived: false
```

To isolate what losing the premise can do, we built a **synthetic** slugify
conversation and sent its states to the live decision model. These were not
captured production turns:

| what the window held | pick | confidence | deliberation |
|---|---|---|---|
| turn 1: the task statement | sonnet-5 | 0.97 | 0.47 |
| turn 2: after reading the spec | sonnet-5 | 0.91 | 0.29 |
| turn 4: after the test fails on the accent | sonnet-5 | 0.83 | 0.51 |
| **turn 5: statement truncated away** | **haiku-4.5** | 0.81 | 0.31 |

The pick flips on the last row in this constructed probe. The confidence barely
moves (0.83 → 0.81), so the current gate cannot distinguish these two answers:
a confident answer to a question missing its premise remains confident. The
43-of-43 haiku turns observed in the routed arm are consistent with this failure
mode, but the actual production `state` for those turns was not recorded;
this probe does **not** establish that every one of those picks lost the premise.

Two confounders were ruled out by measurement rather than argument. Agent
boilerplate in `assistant_instructions` lowers confidence (0.96 → 0.79) but does
**not** flip the pick. The active `ponytail` injection ("lazy senior developer,
ship the one-liner") lowers it further (0.97 → 0.74) and also does not flip it.
In these probes, only losing the statement flipped it.

**The fix** costs the first user turn against the budget *before* the newest-first
walk, so truncation eats tool traffic instead of the premise. The window still
ends on the latest turn and still respects the cap (23794 of 24000 chars on the
loop above). Verified end to end against the live router on a separate synthetic
40-iteration *architecture* task: after the fix the router returned
`kr/claude-opus-5` at strength 0.91, deliberation 0.73. This confirms the
router can escalate when the task anchor survives; it does not establish which
model that exact request would have reached before the fix.

The general lesson is not about this budget. **A context-management policy tuned
for generation is not automatically valid for a routing question asked over the
same context**: generation needs recency, routing needs the premise. Any system
that summarizes, compacts or truncates before asking a small model to decide
should check which turns its policy sacrifices, because the resulting verdict is
confidently wrong rather than visibly degraded.

## 3. Why the gate reads strength, not confidence

The decision model reports a confidence that scales with the number of options, so
a threshold on it tightens every time the pool grows — the same winner reads 1.00
over 3 options and 0.31 over 12. The model gate therefore reads **winner
strength**: the winner's probability measured against the uniform baseline and
rescaled, `(p₁ − 1/n) / (1 − 1/n)`. That subtraction is what removes the option
count; it is a monotone transform of a likelihood ratio against the uniform prior,
the form selective-classification theory gives as optimal for an abstain decision.

Observed over 28 production verdicts on this hardware: mean strength 0.591, median
0.647, range 0.27–0.79. Of those, 23 were applied — 15 `clear`, 8 `confirmed` (a
second agreeing verdict unlocked the ambiguous band), 4 abstained as
`no_favourite`, 1 held for confirmation. The two-band design earns its keep: a
third of the applied verdicts arrived through the confirmation path and would have
been discarded by a single threshold.

## 4. Configuration: three forms, not fourteen knobs

Prior to this work the panel exposed `minConfidence`, `switchConfidence`,
`toolMode`, an effort toggle and a free-text model field — and the two thresholds
the UI wrote were *not the ones the model gate read*, so the presets were
decorative for model routing.

Now one field decides all three axes:

| preset | minStrength | switchStrength | minConfidence (tool) | toolMode | effort cap |
|---|---|---|---|---|---|
| cautious | 0.60 | 0.85 | 0.90 | off | off |
| balanced | 0.35 | 0.60 | 0.70 | hint | on |
| eager | 0.30 | 0.45 | 0.60 | forced | on |

`preset` is re-derived on read (`mergeWithDefaults`) *and* in the runtime
(`normalizeDecisionConfig`), so a stale threshold in a stored blob cannot bypass
the chosen form. `mode` (off / shadow / enforce) stays orthogonal: shadow asks,
prices and logs the verdict without applying it, which is the baseline any savings
claim has to be measured against.

## 5. Availability before deliberation

A combo may nest other combos, and a tier name carries no price. The pool is
therefore expanded to real models, priced, and **filtered by live availability
before the question is built**:

1. expand nested combos to their members, dropping duplicates;
2. rank cheapest-first, resolving provider aliases so a $5 Opus is not sorted as
   if it were unpriced;
3. inspect each candidate's credentials (rate-limit, spend cap, owner binding) and
   keep only the reachable ones;
4. ask only over those; if one remains, skip the call entirely;
5. order the result `[pick, …rest of reachable pool, …unreachable tail]`.

Asking over a model whose account is rate-limited spends a verdict on a route that
cannot serve the turn. The unreachable models stay as the tail the caller's
fallback loop walks last, so an error on the pick falls to the next *reachable*
model first. Both the filter and the tail ordering are pinned by tests that were
mutation-proven: removing the availability filter turns 3 tests red, dropping the
fallback tail turns 2 red.

## 6. Effort as the third axis

The same verdict that picks the model carries a deliberation score, which caps the
reasoning budget for mechanical turns (`<0.3 → low`, `<0.7 → medium`, else
untouched). A cap only ever lowers a budget; a hard turn keeps whatever the client
asked for.

This axis was inert for Kiro. Kiro maps thinking intent to its own
`systemPrompt` / `additionalModelRequestFields` *before* the generic normalization
runs, so the cap was computed and silently dropped. It is now applied to the source
body and re-applied after a `model(level)` suffix override wins, verified by tests
that assert the resulting `additionalModelRequestFields.output_config.effort`.

The literature supports the axis independent of the cost argument: on 4,018 agent
trajectories over SWE-bench Verified, higher "overthinking" scores correlated with
*worse* task performance, and selecting the lower-overthinking solution improved
performance by ~30% while cutting compute 43% (arXiv [2502.08235]). Reasoning
budget is not monotonically good, which is what makes a per-turn ceiling a quality
lever and not only a cost one.

## 7. A diagnostic that was lying

The usage detail view attributed 33.13s of a 38.4s request to "Connect", which
reads as a network problem. `connect_ms` is time-to-response-headers, and a
non-streaming upstream withholds headers until it has read the prompt. Measured
against Kiro:

| request body | time to headers |
|---|---|
| 0.4 KB | 1.05 s |
| 28 KB | 1.12 s |
| 225 KB | 2.25 s |

Linear in body size; the 33s belonged to a 746k-token prefill with the socket long
since open. Renamed to **"Upstream wait"** in the UI and the log, because a
confident wrong label sends the next reader after the network while the cost is
prompt size.

Prompt caching cannot fix it on this provider: across 40 Kiro requests, zero rows
carry `cache_read_input_tokens`, the executor already parses that field, and the
CodeWhisperer wire accepts no `cache_control` breakpoint. The lever for a large
prompt here is the request-token-killer path, not the transport.

## 8. Method, and its limits

**Harness.** Claude Code (`claude -p`) pointed at the local 9Router via
`ANTHROPIC_BASE_URL`, with `CLAUDE_CONFIG_DIR` redirected to a scratch directory so
the child inherits none of the operator's model overrides or session state. Nothing
in the harness knows routing exists; every decision happens server-side, so two
runs differ only in the router's configuration.

**Tasks.** Each ships files plus a check that must fail before the work and pass
after, so "passed" means the work was actually done rather than described. A check
that already passes is reported as SKIP instead of counted.

**Attribution.** The client cannot see what the router spent on its behalf, so the
harness records each run's wall-clock window and `bench-report.mjs` joins the
router's own usage rows to it. Attributing by model name instead would mix the
arms, because the routed arm serves some turns on the very model the control arm
pins. The join was mutation-proven: dropping the window filter inflates a $0.014
fixture to $10.01.

**Arms without reconfiguration.** Only a combo whose strategy is `auto` reaches the
router, so a fixed-model arm and an auto-combo arm are two arms of one experiment
and can run back to back with no settings flip between them.

**Threats to validity.**
- *n=9 per arm, and the intervals still overlap* (56–98% vs 45–94%). No quality
  claim is supported in either direction; the report prints that caveat.
- *One discriminating task, n=3.* §8.2 adds a task where fixed-model runs separate
  haiku (1/3) from sonnet (3/3). That is one task, three repeats per arm; it shows
  the router *can* preserve quality there, not a general rate.
- *The threshold was set after seeing the failure.* `DEFER_DELIBERATION = 0.5`
  sits just under the lowest deliberation observed on the failing task (0.50).
  The rule was re-checked on the three earlier tasks for regressions, but it has
  not been validated on a held-out task.
- *Four tasks, one repo shape.* Small and self-contained; they do not exercise long
  multi-file sessions where cache behaviour dominates.
- *One provider account.* Rate-limit state and prefill latency are Kiro-specific.
- *Cost is list-price arithmetic*, not an invoice: a flat-plan account is scored at
  0 for ranking but at list price for the "don't route a hard task to the cheapest
  model" guard, deliberately.
- *Tier labels are ours.* The 6/6 tier accuracy is against expectations we wrote,
  which is a weaker instrument than an outcome-based label.

## 8.1 Re-measurement after the fix

The routed arm was re-run with the anchor fix in place; the control arm needs no
re-run because a fixed model never reaches the router, so its numbers stand.

| arm | pass | 95% CI | chat | decision | total | $/solved |
|---|---|---|---|---|---|---|
| control `kr/claude-sonnet-5` | 8/9 | 56–98% | $5.64728 | — | $5.64728 | $0.70591 |
| routed, buggy state | 6/9 | 35–88% | $0.50395 | $0.00547 | $0.50943 | $0.08490 |
| routed, anchored state | **7/9** | 45–94% | $0.47020 | $0.00503 | $0.47524 | $0.06789 |

One of three repeats of the previously failing task passed after the fix, versus
zero before. These are independent stochastic runs, not the same trajectory replayed;
that difference is **not** evidence the fix caused a successful solve. Cost is
−91.6% against the control, with the decision model at 1.06% of spend and 32 of 40
verdicts applied.

**This harness still cannot demonstrate routing quality, and it is important to say
why.** All 40 turns were served by haiku. These tasks are a rename, an arithmetic
fix, and a small pure function; none was pre-validated as a task that haiku fails
reliably while sonnet passes. Both arms sometimes miss the accented-character
requirement (`Café` → `caf`, not `cafe`). The results measure solve rates on these
three tasks, not whether routing protects quality on hard tasks.

The evidence that the anchored state routes *up* when a task warrants it therefore
comes from the direct probe, not from this harness: a 40-iteration session whose
turn 0 asks for multi-tenant isolation across auth, DB scoping, cache keys and rate
limits returned `kr/claude-opus-5` at strength 0.91 and deliberation 0.73 through
the live router after the fix. No pre-fix request with that exact state was run,
so this is evidence of escalation, not evidence that the fix caused it. §8.2 closes
part of this gap with a task where a cheap model measurably fails.

## 8.2 A task where the cheap model fails, and a third defect

**The task.** Implement an arithmetic evaluator without dynamic execution, pinned by
a check whose ten cases include `2**3**2 = 512` (right-associative power),
`-2**2 = -4` (unary minus binds looser than power) and `2**-1 = 0.5`. Before any
model ran, the checker itself was validated: a correct recursive-descent parser
passes; the same parser with left-associative power fails; and a lookup table that
answers every case — so arithmetic cannot fail — is rejected when it calls `eval`
or `Function` in any of the tested spellings, while a mention only in a comment and
an identifier named `evaluator` are both accepted.

**Screening with fixed models**, three repeats each, same harness:

| model | pass | failures |
|---|---|---|
| haiku-4.5 | 1/3 | `-2**2` returned 4; `2**-1` returned 0 |
| sonnet-5 | 3/3 | — |

The first attempt at this screen is excluded: the Kiro key had stopped
authenticating mid-run, so five of six trials exited in under a second with the
stub untouched. Those were infrastructure failures, not model results.

**Routed, before any change: 0/3.** Every turn went to haiku. The recorded verdicts
explain why: 19 of 19 abstained — 16 `no_favourite` (strength 0.23–0.34), 3
`awaiting_confirmation` (0.38–0.51) — while rating deliberation 0.50–0.71. The
decision model was saying *this needs thought, and I cannot tell which model*, and
an abstention left the pool in cost order, so the answer defaulted to the cheapest.
The router was least helpful exactly where it was most needed.

**The fix.** An abstention on a step whose deliberation is at least 0.5 now defers
to the next candidate up the cost-ordered pool instead of leaving the cheapest in
front. A verdict that was not usable at all, and a mechanical step, keep the pool
order. Three mutations cover it.

**Routed, after the change**, on the same live router:

| arm | pass | chat | decision | total | served by |
|---|---|---|---|---|---|
| sonnet-5 fixed | 3/3 | $1.90640 | — | $1.90640 | 14 sonnet |
| routed, before | 0/3 | $0.23850 | $0.00262 | $0.24112 | 19 haiku |
| routed, after | **3/3** | $0.67999 | $0.00183 | $0.68181 | 8 haiku, 6 sonnet |

**3/3 at −64.2% against the fixed strong model.** The mix is the point: the router
did not escalate the whole session, only the turns it doubted, and mechanical
turns stayed on haiku.

**Regression check on the earlier tasks.** The same rule re-run on the three easy
tasks: 7/9 at −86.5% against fixed sonnet, with 3 of 44 calls moved to sonnet. The
rule does not tax the mechanical work it should leave alone.

**What this does and does not establish.** It is one discriminating task at n=3 per
arm, and the 0.5 threshold was chosen after seeing the failure (see the threats
above). It shows the policy can close the gap on a task where the gap is real; a
held-out set of discriminating tasks is what would turn that into a rate.

### 8.3 Candidate search without a held-out win

To test whether the `0.5` defer threshold generalizes, we drafted six additional
standalone tasks across range merging, keyed single-flight, safe redirects, quoted
configuration parsing, stable topological order, and cancellation of queued work.
The first three were all solved by haiku in every fixed-model run, so they could
not test whether routing would protect quality. The next three outcomes were:

| candidate | haiku | sonnet | assessment |
|---|---|---|---|
| quoted config parser | 2/2 | 1/1 | too easy |
| stable topological order | 2/2 | 1/1 | too easy |
| abortable work queue | 1/2 | 1/1 | unstable, not reliable discrimination |

These are exploratory screens, **not** held-out policy evaluations. No task was
added to the benchmark or routed after seeing these results. The queue check
initially required the worker to start synchronously even though its contract did
not; it was corrected, then a known-good asynchronous implementation passed and
an implementation that ignored abort failed. A deadlocked pending promise exits
Node with an unsettled-top-level-await warning, which was the observed haiku
failure; one repeat passed. We cannot call this task a stable separator.

Before the next screen, the harness was hardened: a nonzero or timed-out Claude
Code process cannot count as PASS even if it left changed files behind, and any
change to `check.js` or `package.json` invalidates the run. Both guards were
exercised independently with stub CLI mutations. They prevent counting agent
failures or modified checks as model quality.

**Status of the central question:** one in-sample task showed the router recover
quality for less money. Six new candidate screens did not yield an independently
validated discriminating task. The threshold remains unvalidated out of sample;
stop tuning it against these attempts, collect real diverse coding tasks, and
freeze a separate held-out set before reporting a rate.

## 9. Design implications

1. **Fix the option set before tuning the gate.** A gate is only meaningful
   relative to the option count; near-duplicate options dilute probability mass
   in the measured decision probes.
2. **Normalize the acceptance score against the uniform baseline.** Raw softmax
   confidence is not comparable across pool sizes.
3. **Two bands beat one threshold.** A second agreeing verdict unlocked a third of
   the applied verdicts here.
4. **Never put price in the question.** Cost comparison is arithmetic and ours to
   do exactly; asking a small model to weigh a rate table measurably degrades the
   fitness judgment. Cost breaks only the ties the model left behind.
5. **Filter by availability before asking.** A verdict for an unreachable model is
   paid for and discarded.
6. **Keep one operator knob per intent.** Thresholds the UI writes but the runtime
   ignores are worse than no control at all.
7. **Label diagnostics by what they measure**, not by what they usually mean.
8. **Audit what truncation sacrifices before asking a routing question.** A context
   policy tuned for generation optimizes for recency; a routing question needs the
   premise. The synthetic probe showed a high-confidence tier flip when the
   premise was dropped; this particular error escaped the current gate.
9. **Raise N before believing a free lunch.** At n=3 the arms tied in pass rate;
   at n=9 they differed by two successes and the intervals still overlapped.
   Truncation was a real defect found during investigation, but the run did not
   capture enough state to attribute that difference to it.
10. **A benchmark without validated discrimination cannot test quality preservation.**
    Include tasks where repeated fixed-model runs establish a quality gap between
    cheap and strong models before evaluating whether routing closes it. Here, the
    first such task was also the one that exposed the next defect.
11. **Abstention is doubt, not a verdict for cheap.** When the gate abstains on a
    step the decision model itself rates as needing thought, defer up a tier. A
    cost-ordered fallback silently turns "I don't know" into "use the weakest".

## 10. Reproducing

```bash
# screen a task first: it only tests quality if the fixed models disagree
node scripts/bench-harness.mjs --model kr/claude-haiku-4.5 --only t4-expr --repeat 3 --report /tmp/cheap.json
node scripts/bench-harness.mjs --model kr/claude-sonnet-5  --only t4-expr --repeat 3 --report /tmp/strong.json

# both arms, report files for the join
node scripts/bench-harness.mjs --model kr/claude-sonnet-5 --repeat 3 --report /tmp/control.json
node scripts/bench-harness.mjs --model coding-auto       --repeat 3 --report /tmp/routed.json

# pass rate joined to what only the router saw
node scripts/bench-report.mjs --control /tmp/control.json --routed /tmp/routed.json
```

Run the routed arm once with `mode: "shadow"` first: it asks, prices and logs every
verdict while applying none, which is the honest baseline for the comparison.

## References

- RouteLLM: Learning to Route LLMs with Preference Data — arXiv 2406.18665.
  Trained routers between a strong and a weak model cut cost by more than half in
  some evaluations without reducing response quality.
- RouterBench: A Benchmark for Multi-LLM Routing Systems — arXiv 2403.12031.
  Over 405k inference outcomes as a routing evaluation substrate.
- The Danger of Overthinking: Examining the Reasoning-Action Dilemma in Agentic
  Tasks — arXiv 2502.08235. 4,018 trajectories on SWE-bench Verified; selecting
  lower-overthinking solutions improved performance ~30% and cut cost 43%.
- RAG-MCP: Mitigating Prompt Bloat in LLM Tool Selection — arXiv 2505.03275.
  Retrieving tools before prompting cut prompt tokens >50% and raised tool-selection
  accuracy from 13.62% to 43.13%, the same shape as the shortlist step used here for
  large tool rosters.
