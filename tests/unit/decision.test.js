import { describe, expect, it, vi } from "vitest";
import {
  decideStrength,
  winnerStrength,
  resolveModelDecision,
  resolveToolDecision,
  rankByCost,
  cheapestWithinBand,
  MAX_TOOLS,
  NO_TOOL,
} from "../../open-sse/decision/decide.js";
import { normalizeAnswers, decisionUrlFor, DECISION_MODEL_TYPE } from "../../open-sse/decision/jev.js";
import { buildState, hasCacheBreakpoint } from "../../open-sse/decision/state.js";
import { buildModelQuestions, buildShortlistQuestions, buildToolQuestions, readShortlist, shortlistTools, SHORTLIST_MAX } from "../../open-sse/decision/questions.js";
import { injectHint, hintText } from "../../open-sse/decision/injectHint.js";
import { extractTools, applyToolChoice, supportsToolChoice, UNSUPPORTED_EXECUTORS } from "../../open-sse/decision/tools.js";
import { rankPool, priceOf } from "../../src/sse/services/decisionRouter.js";

const choice = (pick, confidence, probabilities) => ({
  type: "choice",
  choice: pick,
  confidence,
  probabilities: probabilities || { [pick]: confidence },
});
const noul = (p) => ({ type: "noul", noul: p });

describe("normalizeAnswers", () => {
  it("fills a missing choice confidence from the highest probability", () => {
    // Resellers omit `confidence`. Without this the threshold reads undefined and
    // every decision is silently discarded — a total failure, not a degraded one.
    const out = normalizeAnswers({
      model: { type: "choice", choice: "a", probabilities: { a: 0.62, b: 0.28 } },
    });
    expect(out.model.confidence).toBe(0.62);
  });

  it("keeps an explicit confidence and never invents one for noul", () => {
    const out = normalizeAnswers({
      model: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9 } },
      needs: { type: "noul", noul: 0.4 },
    });
    expect(out.model.confidence).toBe(0.9);
    expect(out.needs).toEqual({ type: "noul", noul: 0.4 });
  });
});

// The gate reads SEPARATION (top-1 minus top-2), never the confidence jev reports:
// measured on one state, the same winner scored confidence 1.00 over 3 options,
// 0.45 over 6 and 0.31 over 12. A threshold on that value silently tightened every
// time the pool grew, which is how 97% of verdicts were discarded.
// The model gate reads winner STRENGTH, never the confidence jev reports: that
// value scales with the option count — measured on one state, the same winner
// scored 1.00 over 3 options, 0.45 over 6 and 0.31 over 12 — so a threshold on it
// tightened silently every time the pool grew, which is how 97% were discarded.
describe("winnerStrength", () => {
  it("scales the winner against the uniform baseline of the option count", () => {
    // 3 options, uniform 0.3333: (0.6667 - 0.3333) / (1 - 0.3333) = 0.5
    expect(winnerStrength({ probabilities: { a: 0.6667, b: 0.2, c: 0.1333 } })).toBeCloseTo(0.5, 3);
    // A flat distribution has no favourite.
    expect(winnerStrength({ probabilities: { a: 0.34, b: 0.33, c: 0.33 } })).toBeCloseTo(0.01, 2);
    // Everything on one option is the maximum.
    expect(winnerStrength({ probabilities: { a: 1, b: 0 } })).toBeCloseTo(1, 5);
  });

  it("is what the raw probability is not: the same strength whatever the option count", () => {
    // Equal distance above each pool's own uniform baseline, so equal strength —
    // 0.60 of 3 and 0.45 of 12 are both 0.4 above their floor. The raw p1 differs,
    // which is exactly why it cannot be the threshold.
    const three = winnerStrength({ probabilities: { a: 0.6, b: 0.2, c: 0.2 } });
    const twelve = winnerStrength({
      probabilities: { a: 0.45, ...Object.fromEntries("bcdefghijkl".split("").map((k) => [k, 0.55 / 11])) },
    });
    expect(three).toBeCloseTo(0.4, 3);
    expect(twelve).toBeCloseTo(0.4, 3);
  });

  it("treats a one-option or empty distribution as certain and undecided", () => {
    expect(winnerStrength({ probabilities: { a: 1 } })).toBe(1);
    expect(winnerStrength({ probabilities: {} })).toBe(0);
    expect(winnerStrength(null)).toBe(0);
  });
});

describe("decideStrength", () => {
  it("refuses a verdict with no favourite", () => {
    expect(decideStrength({ strength: 0.05, verdict: "x" })).toMatchObject({ change: false, reason: "no_favourite" });
  });

  it("changes on the same turn above the clear band", () => {
    expect(decideStrength({ strength: 0.8, verdict: "x" })).toMatchObject({ change: true, reason: "clear" });
  });

  // This is the point of the two bands. Collapsing switchStrength down to
  // minStrength makes this case take the "clear" branch and turns this red —
  // and nothing else in this file covers it.
  it("in the ambiguous band, waits for a second agreeing verdict", () => {
    expect(decideStrength({ strength: 0.45, verdict: "x", previousVerdict: null }))
      .toMatchObject({ change: false, reason: "awaiting_confirmation" });
    expect(decideStrength({ strength: 0.45, verdict: "x", previousVerdict: "y" }))
      .toMatchObject({ change: false, reason: "awaiting_confirmation" });
    expect(decideStrength({ strength: 0.45, verdict: "x", previousVerdict: "x" }))
      .toMatchObject({ change: true, reason: "confirmed" });
  });
});

describe("rankByCost", () => {
  it("orders cheapest first and keeps pool order between equal prices", () => {
    const prices = { a: 5, b: 1, c: 5, d: null };
    expect(rankByCost(["a", "b", "c", "d"], (m) => prices[m])).toEqual(["b", "a", "c", "d"]);
  });

  it("sorts an unpriced model last: it cannot be shown to be the cheap choice", () => {
    expect(rankByCost(["x", "y"], (m) => (m === "x" ? null : 3))).toEqual(["y", "x"]);
    // All unpriced keeps the caller's order rather than reshuffling.
    expect(rankByCost(["x", "y"], () => null)).toEqual(["x", "y"]);
  });
});

// The pool is ranked cheapest first and the depth score walks that order, so the
// tier is chosen by code. Asking the model to compare prices itself measured 0.62
// on a state where this scores 0.82 — the arithmetic, not the judgment, is what it
// could not do. Mutating the tier arithmetic below must be the only failure.
describe("cheapestWithinBand", () => {
  const priceOf = (m) => ({ "p/opus": 5, "p/sonnet": 3, "p/haiku": 1 }[m] ?? null);

  it("takes the cheapest model jev rated as good as its pick", () => {
    // The case this exists for: it could not separate the two, and one costs less.
    // Measured as 27% of production answers, nearly all one tier apart.
    expect(cheapestWithinBand("p/sonnet", { "p/sonnet": 0.50, "p/haiku": 0.48, "p/opus": 0.02 }, priceOf))
      .toBe("p/haiku");
  });

  it("leaves a clear verdict alone", () => {
    // Nothing else is close, so there is no tie to break and no saving to take.
    expect(cheapestWithinBand("p/opus", { "p/opus": 0.95, "p/sonnet": 0.04, "p/haiku": 0.01 }, priceOf))
      .toBe("p/opus");
  });

  it("never reaches past a model jev rated lower, however cheap", () => {
    // The cheapest model in the pool is far below the winner: taking it would be
    // using cost to overrule a judgment, which is the thing that broke before.
    expect(cheapestWithinBand("p/opus", { "p/opus": 0.9, "p/sonnet": 0.05, "p/haiku": 0.05 }, priceOf))
      .toBe("p/opus");
  });

  it("keeps the pick when it is already the cheapest of the band, or unpriced", () => {
    expect(cheapestWithinBand("p/haiku", { "p/haiku": 0.5, "p/sonnet": 0.45 }, priceOf)).toBe("p/haiku");
    // Unknown is not cheap: an unpriced model never wins a tie-break.
    const unknown = (m) => (m === "p/haiku" ? null : priceOf(m));
    expect(cheapestWithinBand("p/sonnet", { "p/sonnet": 0.5, "p/haiku": 0.48 }, unknown)).toBe("p/sonnet");
    expect(cheapestWithinBand("p/haiku", { "p/haiku": 0.5, "p/sonnet": 0.48 }, unknown)).toBe("p/haiku");
  });
});

describe("resolveModelDecision", () => {
  const models = ["p/haiku", "p/sonnet", "p/opus"];
  const priceOf = (m) => ({ "p/opus": 5, "p/sonnet": 3, "p/haiku": 1, "p/luna": 1, "p/terra": 2.5, "p/flash": 0.14 }[m] ?? null);
  const answers = (pick, conf, probs, needs = 0.15) => ({
    model: choice(pick, conf, probs),
    needs_reasoning: noul(needs),
  });

  it("applies the model jev picked when it is clearly the best fit", () => {
    const out = resolveModelDecision({
      answers: answers("p/opus", 0.97, { "p/opus": 0.97, "p/sonnet": 0.02, "p/haiku": 0.01 }),
      models, priceOf, cheapest: "p/haiku",
    });
    expect(out).toMatchObject({ apply: true, model: "p/opus" });
    expect(out.downgradedFrom).toBeUndefined();
  });

  it("routes to the cheaper model when jev could not separate them", () => {
    // A pool wide enough that both dimensions can hold at once: a favourite clear
    // of the uniform floor, with the runner-up still inside the tie band. In a
    // 3-option pool those two are arithmetically incompatible — a 0.35 strength
    // floor forces p1>=0.567, which leaves no room for a runner-up within 0.15.
    const wide = ["p/opus", "p/sonnet", "p/haiku", "p/luna", "p/terra", "p/flash"];
    const probs = { "p/sonnet": 0.50, "p/haiku": 0.38, "p/opus": 0.03, "p/luna": 0.03, "p/terra": 0.03, "p/flash": 0.03 };
    // p1=0.50 with the runner-up 0.12 behind: strength 0.40 clears the floor, and
    // the gap is inside the tie band. A tie can never reach the same-turn band —
    // p1 <= 0.575 whenever the runner-up is within 0.15 — so the first sighting is
    // recorded and the second applies it.
    // The first sighting is recorded, the second applies it.
    const first = resolveModelDecision({ answers: answers("p/sonnet", 0.9, probs), models: wide, priceOf });
    expect(first).toMatchObject({ apply: false, reason: "awaiting_confirmation", model: "p/haiku", downgradedFrom: "p/sonnet" });
    const out = resolveModelDecision({
      answers: answers("p/sonnet", 0.9, probs), models: wide, priceOf, previousVerdict: "p/haiku",
    });
    expect(out).toMatchObject({ apply: true, model: "p/haiku", downgradedFrom: "p/sonnet", reason: "confirmed" });
  });

  it("refuses the dangerous contradiction: hard step routed to the cheapest model", () => {
    // The failure the operator cannot see — quality lost silently.
    const out = resolveModelDecision({
      answers: answers("p/haiku", 0.99, { "p/haiku": 0.99 }, 0.9),
      models, priceOf, cheapest: "p/haiku",
    });
    expect(out).toMatchObject({ apply: false, reason: "signals_disagree" });
  });

  it("refuses a pick outside the pool and a missing deliberation signal", () => {
    expect(resolveModelDecision({
      answers: answers("p/gpt", 0.99, { "p/gpt": 0.99 }, 0.9),
      models, priceOf,
    }).reason).toBe("no_usable_pick");
    expect(resolveModelDecision({
      answers: { model: choice("p/opus", 0.99) },
      models, priceOf,
    }).reason).toBe("no_deliberation_signal");
  });

  it("still applies the pick when no price is known to break a tie with", () => {
    const wide = ["p/opus", "p/sonnet", "p/haiku", "p/luna", "p/terra", "p/flash"];
    const out = resolveModelDecision({
      answers: answers("p/sonnet", 0.9, { "p/sonnet": 0.50, "p/haiku": 0.38, "p/opus": 0.03, "p/luna": 0.03, "p/terra": 0.03, "p/flash": 0.03 }),
      models: wide, previousVerdict: "p/sonnet",
    });
    expect(out).toMatchObject({ apply: true, model: "p/sonnet" });
  });
});

describe("resolveToolDecision", () => {
  const tools = ["Bash", "Read", "Edit"];
  const plans = tools.map((name) => ({ name, kind: "function" }));
  const answers = (pick, conf, needs) => ({ tool: choice(pick, conf), needs_tool: noul(needs) });

  it("forces the picked tool when there is no cache to protect", () => {
    expect(resolveToolDecision({ answers: answers("Bash", 0.9, 0.8), tools, plans }))
      .toMatchObject({ mode: "forced", tool: "Bash" });
  });

  it("pins no-tool only when it is safe to mutate tool_choice", () => {
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.9, 0.1), tools, plans }))
      .toMatchObject({ mode: "none" });
  });

  // The cache rule. Mutating tool_choice rewrites the cached prefix; on a 60k
  // prefix at the top tier that costs more than many turns of the saving.
  it("moves to a hint rather than abstaining when forced is not allowed", () => {
    // A hint is available at every ceiling, so a downgrade beats doing nothing.
    expect(resolveToolDecision({ answers: answers("Bash", 0.9, 0.8), tools, plans, allowed: "hint" }))
      .toMatchObject({ mode: "hint", tool: "Bash" });
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.9, 0.1), tools, plans, allowed: "hint" }))
      .toMatchObject({ mode: "passthrough", reason: "mode_not_allowed" });
  });

  // Anthropic rejects a pinned tool_choice while thinking is enabled:
  // "Thinking mode does not support this tool_choice". The verdict must degrade to a
  // hint, which writes no tool_choice at all. Exercised here rather than through the
  // config ceiling: `allowed: "forced"` stays the default, so only this flag can
  // turn the answer into a hint.
  it("never pins a tool when extended thinking is on", () => {
    expect(resolveToolDecision({ answers: answers("Bash", 0.9, 0.8), tools, plans, extendedThinking: true }))
      .toMatchObject({ mode: "hint", tool: "Bash", reason: "thinking_blocks_tool_choice" });
    // The same answers without thinking still force, so the flag is what moved it.
    expect(resolveToolDecision({ answers: answers("Bash", 0.9, 0.8), tools, plans }))
      .toMatchObject({ mode: "forced" });
  });

  it("needs the two questions to agree", () => {
    // Picked a tool but says no tool is needed: measured shape on a 77-tool roster.
    expect(resolveToolDecision({ answers: answers("Bash", 0.95, 0.1), tools, plans }))
      .toMatchObject({ mode: "passthrough", reason: "signals_disagree" });
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.95, 0.9), tools, plans }))
      .toMatchObject({ mode: "passthrough", reason: "signals_disagree" });
  });

  it("refuses low confidence, oversized rosters and unsafe names", () => {
    expect(resolveToolDecision({ answers: answers("Bash", 0.4, 0.9), tools, plans }).reason).toBe("low_confidence");
    const big = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => `t${i}`);
    expect(resolveToolDecision({ answers: answers("t0", 0.9, 0.9), tools: big, plans: [] }).reason).toBe("roster_too_large");
    // A tool name reaches both an option label and, in hint mode, model-readable text.
    expect(resolveToolDecision({ answers: answers("a b", 0.9, 0.9), tools: ["a b"], plans: [] }).reason).toBe("unsafe_tool_name");
    expect(resolveToolDecision({ answers: answers("a", 0.9, 0.9), tools: ["a", "a"], plans: [] }).reason).toBe("duplicate_tool_names");
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.9, 0.1), tools: [...tools, NO_TOOL], plans }).reason).toBe("reserved_tool_name");
  });

  it("never forces a tool the target cannot be forced into", () => {
    expect(resolveToolDecision({
      answers: answers("web_search", 0.9, 0.9),
      tools: ["web_search"],
      plans: [{ name: "web_search", kind: "hosted" }],
    })).toMatchObject({ mode: "passthrough", reason: "hosted_tool_selected" });
  });
});

describe("buildState", () => {
  it("keeps the newest turns and reports what it dropped", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `turn ${i} ${"x".repeat(400)}` }));
    const state = buildState({ messages }, { maxStateChars: 4000, maxMessageChars: 500 });
    expect(state.conversation.length).toBeGreaterThan(0);
    expect(state.conversation.length).toBeLessThan(40);
    expect(state.earlier_turns_omitted).toBe(40 - state.conversation.length);
    // Newest kept: the last turn survives.
    expect(state.conversation.at(-1).text).toContain("turn 39");
  });

  it("reads whichever known shape the client used, and degrades on unknown ones", () => {
    expect(buildState({ system: "sys", messages: [{ role: "user", content: "hi" }] }).assistant_instructions).toBe("sys");
    // OpenAI Responses
    expect(buildState({ instructions: "sys2", input: [{ role: "user", content: "hi" }] }).conversation).toHaveLength(1);
    // Gemini
    expect(buildState({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }).conversation[0].text).toBe("hi");
    // Unknown shape still gets something to read rather than nothing.
    expect(buildState({ weird: { deep: true } }).request).toContain("weird");
  });

  it("flattens content parts and marks media", () => {
    const state = buildState({
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: {} }] }],
    });
    expect(state.conversation[0].text).toContain("look");
    expect(state.conversation[0].text).toContain("[image_url]");
  });
});

describe("hasCacheBreakpoint", () => {
  it("finds a breakpoint anywhere it can hide", () => {
    expect(hasCacheBreakpoint({ cache_control: { type: "ephemeral" } })).toBe(true);
    expect(hasCacheBreakpoint({ system: [{ type: "text", cache_control: {} }] })).toBe(true);
    expect(hasCacheBreakpoint({ messages: [{ role: "user", content: [{ type: "text", cache_control: {} }] }] })).toBe(true);
    expect(hasCacheBreakpoint({ messages: [{ role: "user", content: "plain" }] })).toBe(false);
  });
});

describe("questions", () => {
  // Every builder returns { questions, ... }. The mixed contract is what let a
  // caller destructure `{ questions }` from a bare map, get undefined, and fail
  // open silently — the bug survived a live API test because fail-open hides it.
  it("all builders use the same { questions } shape", () => {
    const model = buildModelQuestions(["p/a"], () => "brief");
    const tool = buildToolQuestions([{ name: "Bash", description: "runs" }]);
    const short = buildShortlistQuestions(Array.from({ length: 200 }, (_, i) => ({ name: `t${i}` })));
    for (const [name, built] of Object.entries({ model, tool, short })) {
      expect(built, name).toHaveProperty("questions");
      expect(typeof built.questions, name).toBe("object");
      expect(Object.keys(built.questions).length, name).toBeGreaterThan(0);
    }
  });

  it("asks which model fits, and never how much one costs", () => {
    // A non-model option in a model question absorbed 39-45% of the probability
    // mass and wrecked the decision, so only the pool's own models are options.
    const { questions } = buildModelQuestions(["p/haiku", "p/opus"], (m) => `brief for ${m}`);
    expect(questions.model.type).toBe("choice");
    expect(Object.keys(questions.model.criteria).sort()).toEqual(["p/haiku", "p/opus"]);
    expect(questions.model.criteria).not.toHaveProperty(NO_TOOL);
    // Price is the one thing that must not reach the question: comparing a rate
    // table is arithmetic, and the answer it produced measured 0.45 against 0.62.
    expect(JSON.stringify(questions)).not.toMatch(/\$\d|\/M\b/);
  });

  it("offers the no-tool escape only in the tool choice", () => {
    const { questions } = buildToolQuestions([{ name: "Bash", description: "runs a command" }]);
    expect(questions.tool.criteria).toHaveProperty(NO_TOOL);
    expect(questions.needs_tool.type).toBe("noul");
  });

  it("shortlists the best few per shard when the roster is too big", () => {
    const tools = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}`, description: `tool ${i}` }));
    const { questions, shards } = buildShortlistQuestions(tools);
    expect(Object.keys(questions).length).toBe(shards.length);
    // Every shard must fit the API's 255-option ceiling.
    for (const s of shards) expect(s.length).toBeLessThanOrEqual(MAX_TOOLS);
    const answers = { "shard:0": { type: "choice", probabilities: { t0: 0.9, t1: 0.5, t2: 0.4, t3: 0.1 } } };
    expect(readShortlist(answers, shards).length).toBe(3);
  });
});

describe("injectHint", () => {
  it("appends after the last cache breakpoint, never inside the prefix", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "do the thing" },
      ],
      tools: [],
    };
    expect(injectHint(body, "claude", "Bash")).toBe(true);
    // The system block carrying the breakpoint is untouched, so the cached prefix
    // stays byte-identical across turns.
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "sys", cache_control: { type: "ephemeral" } });
    expect(body.messages[1].content.at(-1).text).toContain("Bash");
  });

  it("is idempotent", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(injectHint(body, "openai", "Read")).toBe(true);
    const after = JSON.stringify(body);
    expect(injectHint(body, "openai", "Read")).toBe(false);
    expect(JSON.stringify(body)).toBe(after);
  });

  it("handles Responses and Gemini shapes, and refuses an unsafe name", () => {
    const responses = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    expect(injectHint(responses, "openai-responses", "Grep")).toBe(true);
    expect(responses.input[0].content.at(-1).type).toBe("input_text");

    const gemini = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    expect(injectHint(gemini, "gemini", "Edit")).toBe(true);
    expect(gemini.contents[0].parts.at(-1).text).toContain("Edit");

    expect(hintText("a\nb<x>")).toBeNull();
    expect(hintText("Bash")).toContain("Bash");
  });

  it("fails open on a shape it does not know", () => {
    expect(injectHint({ weird: true }, "kiro", "Bash")).toBe(false);
  });
});


describe("decision route resolution", () => {
  // The decision route is derived from the gateway's own transport, so adding a
  // gateway never means hardcoding a second host — and there is no separate
  // provider identity to keep in sync with the credential.
  it("resolves the decision URL against the gateway transport origin", () => {
    const url = decisionUrlFor({
      transport: { baseUrl: "https://ai-gateway.vercel.sh/v1/chat/completions" },
      decisionConfig: { path: "/typesafe/v1/systemone" },
    });
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
  });

  it("returns null rather than guessing when either half is missing", () => {
    expect(decisionUrlFor({ transport: { baseUrl: "https://x.sh/v1/chat" } })).toBeNull();
    expect(decisionUrlFor({ decisionConfig: { path: "/p" } })).toBeNull();
    expect(decisionUrlFor(null)).toBeNull();
  });

  it("names the catalog type that marks a decision model", () => {
    // Measured against the live catalog: typesafe-ai/jev is type "evaluation"
    // with max_tokens 0, which is how a decision model is told from a chat model.
    expect(DECISION_MODEL_TYPE).toBe("evaluation");
  });
});

describe("tool extraction and application", () => {
  it("reads the roster from each target wire shape", () => {
    // OpenAI chat
    expect(extractTools({ tools: [{ type: "function", function: { name: "Bash", description: "runs" } }] }, "openai"))
      .toEqual([{ name: "Bash", description: "runs", kind: "function" }]);
    // Claude: custom/absent type is a client tool, a versioned type is provider-run
    const claude = extractTools({
      tools: [
        { name: "Read", description: "reads", input_schema: {} },
        { type: "web_search_20250305", name: "web_search" },
      ],
    }, "claude");
    expect(claude).toEqual([
      { name: "Read", description: "reads", kind: "function" },
      { name: "web_search", description: undefined, kind: "hosted" },
    ]);
    // Bedrock Converse
    expect(extractTools({ toolConfig: { tools: [{ toolSpec: { name: "Edit", description: "edits" } }] } }, "bedrock-converse"))
      .toEqual([{ name: "Edit", description: "edits", kind: "function" }]);
    // Gemini
    expect(extractTools({ tools: [{ functionDeclarations: [{ name: "Grep", description: "searches" }] }] }, "gemini"))
      .toEqual([{ name: "Grep", description: "searches", kind: "function" }]);
    // a built-in listed twice is one option, not two
    expect(extractTools({ tools: [{ type: "code_interpreter" }, { type: "code_interpreter" }] }, "openai")).toHaveLength(1);
    expect(extractTools({}, "openai")).toEqual([]);
    expect(extractTools(null, "openai")).toEqual([]);
  });

  it("only claims tool_choice for formats where writing it works", () => {
    expect(supportsToolChoice("openai")).toBe(true);
    expect(supportsToolChoice("claude")).toBe(true);
    expect(supportsToolChoice("bedrock-converse")).toBe(true);
    // Binary/NDJSON upsteam formats never reach the translator, so there is no
    // tool_choice to write.
    expect(supportsToolChoice("kiro")).toBe(false);
    expect(supportsToolChoice("cursor")).toBe(false);
    for (const executor of ["kiro", "cursor", "commandcode", "windsurf", "devin-cli", "zed"]) {
      expect(UNSUPPORTED_EXECUTORS.has(executor)).toBe(true);
    }
  });

  it("writes the decision in the target's own shape", () => {
    const claude = {};
    expect(applyToolChoice(claude, "claude", { mode: "forced", tool: "Bash" })).toBe(true);
    expect(claude.tool_choice).toEqual({ type: "tool", name: "Bash" });
    const openai = {};
    expect(applyToolChoice(openai, "openai", { mode: "forced", tool: "Read" })).toBe(true);
    expect(openai.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
    const converse = {};
    expect(applyToolChoice(converse, "bedrock-converse", { mode: "none" })).toBe(true);
    expect(converse.toolConfig.toolChoice).toEqual({ none: {} });
    // hint is text, not tool_choice; nothing to write here
    expect(applyToolChoice({}, "claude", { mode: "hint", tool: "Bash" })).toBe(false);
  });
});


describe("toolMode as a ceiling", () => {
  const tools = ["Bash", "Read"];
  const plans = tools.map((name) => ({ name, kind: "function" }));
  const answers = (pick, conf, needs) => ({
    tool: { type: "choice", choice: pick, confidence: conf, probabilities: { [pick]: conf } },
    needs_tool: { type: "noul", noul: needs },
  });

  it("off touches nothing, so model routing can run on its own", () => {
    // Needed to isolate the two features in a bench, and to run model routing
    // without tool routing on a roster where the latter measured poorly.
    expect(resolveToolDecision({ answers: answers("Bash", 0.99, 0.9), tools, plans, allowed: "off" }))
      .toMatchObject({ mode: "passthrough", reason: "mode_not_allowed" });
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.99, 0.1), tools, plans, allowed: "off" }))
      .toMatchObject({ mode: "passthrough", reason: "mode_not_allowed" });
  });

  it("an unrecognised value grants the narrowest authority, not the widest", () => {
    expect(resolveToolDecision({ answers: answers("Bash", 0.99, 0.9), tools, plans, allowed: "forc3d" }))
      .toMatchObject({ mode: "passthrough", reason: "mode_not_allowed" });
  });
});

describe("shortlistTools", () => {
  const roster = Array.from({ length: 200 }, (_, i) => ({
    name: `tool${i}`,
    description: i === 7 ? "Runs the project test suite and reports failures." : `Operation ${i} on the project.`,
  }));

  it("leaves a roster that already fits untouched", () => {
    const small = roster.slice(0, 10);
    expect(shortlistTools(small, { messages: [{ role: "user", content: "x" }] })).toBe(small);
  });

  it("keeps the tool the request is about", () => {
    const body = { messages: [{ role: "user", content: "run the project test suite" }] };
    const kept = shortlistTools(roster, body);
    expect(kept.length).toBe(SHORTLIST_MAX);
    expect(kept.map((t) => t.name)).toContain("tool7");
  });

  it("keeps a tool the conversation already called", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "tool150", input: {} }] },
        { role: "user", content: "agora faca outra coisa completamente diferente" },
      ],
    };
    expect(shortlistTools(roster, body).map((t) => t.name)).toContain("tool150");
  });

  it("survives a body with no recognisable turns", () => {
    expect(shortlistTools(roster, {})).toHaveLength(SHORTLIST_MAX);
    expect(shortlistTools(roster, { messages: [null] })).toHaveLength(SHORTLIST_MAX);
  });
});

describe("a partially stored decisionRouter keeps its shape", () => {
  // updateSettings spreads the body shallowly, so PATCHing one field replaces the
  // whole nested object. Measured on a live gateway: the panel then showed
  // "no connection yet" and linked to /dashboard/providers/undefined while the
  // runtime carried on with defaults, because only the runtime normalized.
  it("fills the sub-keys a partial write dropped", async () => {
    const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");
    const merged = mergeWithDefaults({ decisionRouter: { effort: true } });
    expect(merged.decisionRouter.effort).toBe(true);
    expect(merged.decisionRouter.provider).toBe("vercel-ai-gateway");
    expect(merged.decisionRouter.model).toBe("typesafe-ai/jev");
    expect(merged.decisionRouter.models).toEqual([]);
    expect(merged.decisionRouter.mode).toBe("off");
  });

  it("leaves a written value alone", async () => {
    const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");
    const merged = mergeWithDefaults({ decisionRouter: { provider: "openrouter", models: ["c"] } });
    expect(merged.decisionRouter.provider).toBe("openrouter");
    expect(merged.decisionRouter.models).toEqual(["c"]);
    expect(merged.decisionRouter.toolMode).toBe("hint");
  });
});

// The pool a combo-of-combos routes over. Two separate failures live here, and
// both were silent: a nested combo priced by its NAME (PATTERN_PRICING's
// `claude-*` catch-all gives a combo called "claude-auto" a $3 that means
// nothing), and a provider ALIAS never resolved to its id, which returned null
// for every Bedrock model and sorted a $5 Opus to the bottom as if it were free.
describe("rankPool — combo-of-combos", () => {
  const TIERS = {
    "tier-hard": ["cc/claude-opus-5", "br/global.anthropic.claude-opus-4-6-v1"],
    "tier-cheap": ["cc/claude-haiku-4-5-20251001", "ocg/deepseek-flash"],
  };
  const resolveMember = async (name) => TIERS[name] || null;

  it("expands nested combos to the models they can reach, cheapest first", async () => {
    const pool = await rankPool(["tier-hard", "tier-cheap"], resolveMember);
    // No tier name survives: the depth score picks among real models.
    expect(pool.some((m) => !m.includes("/"))).toBe(false);
    expect(pool).toContain("cc/claude-opus-5");
    expect(pool).toContain("ocg/deepseek-flash");
    // Cheapest first, so the cheapest model of any tier leads and an Opus ends up last.
    expect(pool[0]).toBe("ocg/deepseek-flash");
    expect(pool[pool.length - 1]).toMatch(/opus/);
  });

  it("prices a Bedrock model through its alias instead of dropping it to the end", async () => {
    // "br" is the alias, "bedrock" the id the pricing tables are keyed by. Unresolved,
    // this Opus reads as unpriced and a hard step routes to the cheapest model.
    expect(priceOf("br/global.anthropic.claude-opus-4-6-v1")).toBe(priceOf("cc/claude-opus-5"));
    // Priced, so it sorts with the other Opus rather than after every cheap model.
    const pool = await rankPool(["tier-hard", "tier-cheap"], resolveMember);
    expect(pool.indexOf("br/global.anthropic.claude-opus-4-6-v1"))
      .toBeGreaterThan(pool.indexOf("ocg/deepseek-flash"));
  });

  it("never prices a bare combo name, however much it looks like a model", async () => {
    // The catch-all pattern matches these; a combo is not the model it is named after.
    expect(priceOf("claude-auto")).toBeNull();
    expect(priceOf("claude-opus-5")).toBeNull();
  });

  it("keeps a shared fallback once, at its first position", async () => {
    const shared = {
      a: ["cc/claude-opus-5", "ocg/deepseek-flash"],
      b: ["cc/claude-sonnet-5", "ocg/deepseek-flash"],
    };
    const pool = await rankPool(["a", "b"], async (n) => shared[n]);
    expect(pool.filter((m) => m === "ocg/deepseek-flash")).toHaveLength(1);
    expect(pool).toHaveLength(3);
  });

  it("keeps a member that resolves to nothing rather than dropping it", async () => {
    const pool = await rankPool(["cc/claude-opus-5", "unknown-combo"], async () => null);
    expect(pool).toContain("unknown-combo");
  });
});

// The bug this pins, measured in production at 243 of 243 calls: the question was
// built over the combo's own member list (tier names for a combo-of-combos) while
// the verdict was validated against the expanded pool. jev answered a tier name the
// pool did not contain, and every verdict was discarded as `no_usable_pick`.
const target = { url: "https://gw.test/systemone", apiKey: "vk", provider: "vercel-ai-gateway", connectionId: "conn-1", callerApiKey: "sk-caller" };
vi.mock("@/lib/db/index.js", () => ({ saveRequestUsage: async () => {} }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestDetail: async () => {} }));

describe("decideComboModel asks over the pool it validates against", () => {
  it("offers the expanded models as the Choice options, not the nested combo names", async () => {
    const { decideComboModel } = await import("../../src/sse/services/decisionRouter.js");
    let asked = null;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      asked = JSON.parse(init.body);
      return new Response(JSON.stringify({
        model: "typesafe-ai/jev",
        answers: {
          // jev answers with an option it was actually offered.
          model: { type: "choice", choice: "cc/claude-opus-5", confidence: 0.95, probabilities: { "cc/claude-opus-5": 0.95, "ocg/deepseek-flash": 0.03 } },
          needs_reasoning: { type: "noul", noul: 0.5 },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const models = ["tier-hard", "tier-cheap"];
    const ranked = ["ocg/deepseek-flash", "cc/claude-opus-5"];
    await decideComboModel({
      body: { messages: [{ role: "user", content: "oi" }] },
      models, ranked, comboName: "c",
      config: { model: "typesafe-ai/jev", minConfidence: 0.7, switchConfidence: 0.85, timeoutMs: 1000, briefs: {} },
      target, log: {},
    });

    const options = Object.keys(asked.questions.model.criteria);
    // Every option offered must be a model the verdict is validated against.
    expect(options.sort()).toEqual(["cc/claude-opus-5", "ocg/deepseek-flash"]);
    expect(options).not.toContain("tier-hard");
    vi.unstubAllGlobals();
  });

  it("keeps the verdict instead of discarding it as no_usable_pick", async () => {
    const { decideComboModel } = await import("../../src/sse/services/decisionRouter.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "typesafe-ai/jev",
      answers: {
        model: { type: "choice", choice: "cc/claude-opus-5", confidence: 0.95, probabilities: { "cc/claude-opus-5": 0.95 } },
        needs_reasoning: { type: "noul", noul: 0.5 },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const out = await decideComboModel({
      body: { messages: [{ role: "user", content: "oi" }] },
      models: ["tier-hard", "tier-cheap"],
      ranked: ["ocg/deepseek-flash", "cc/claude-opus-5"],
      comboName: "c",
      config: { model: "typesafe-ai/jev", minConfidence: 0.7, switchConfidence: 0.85, timeoutMs: 1000, briefs: {} },
      target, log: {},
    });

    expect(out.decision.apply).toBe(true);
    expect(out.decision.reason).not.toBe("no_usable_pick");
    expect(out.models[0]).toBe("cc/claude-opus-5");
    vi.unstubAllGlobals();
  });
});
