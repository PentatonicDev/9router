import { describe, expect, it } from "vitest";
import {
  decideSwitch,
  resolveModelDecision,
  resolveToolDecision,
  MAX_TOOLS,
  NO_TOOL,
} from "../../open-sse/decision/decide.js";
import { normalizeAnswers, ROUTES } from "../../open-sse/decision/jev.js";
import { buildState, hasCacheBreakpoint } from "../../open-sse/decision/state.js";
import { buildModelQuestions, buildShortlistQuestions, buildToolQuestions, readShortlist } from "../../open-sse/decision/questions.js";
import { injectHint, hintText } from "../../open-sse/decision/injectHint.js";
import { resolveCriteria } from "../../open-sse/decision/modelBriefs.js";
import { extractTools, applyToolChoice, supportsToolChoice, UNSUPPORTED_EXECUTORS } from "../../open-sse/decision/tools.js";

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

describe("decideSwitch", () => {
  it("refuses below the floor", () => {
    expect(decideSwitch({ confidence: 0.57, verdict: "x" })).toMatchObject({ change: false, reason: "low_confidence" });
  });

  it("changes on the same turn above the clear band", () => {
    expect(decideSwitch({ confidence: 0.96, verdict: "x" })).toMatchObject({ change: true, reason: "clear" });
  });

  // This is the point of the two bands. Collapsing switchConfidence down to
  // minConfidence makes this case take the "clear" branch and turns this red —
  // and nothing else in this file covers it.
  it("in the ambiguous band, waits for a second agreeing verdict", () => {
    expect(decideSwitch({ confidence: 0.77, verdict: "x", previousVerdict: null }))
      .toMatchObject({ change: false, reason: "awaiting_confirmation" });
    expect(decideSwitch({ confidence: 0.77, verdict: "x", previousVerdict: "y" }))
      .toMatchObject({ change: false, reason: "awaiting_confirmation" });
    expect(decideSwitch({ confidence: 0.77, verdict: "x", previousVerdict: "x" }))
      .toMatchObject({ change: true, reason: "confirmed" });
  });
});

describe("resolveModelDecision", () => {
  const models = ["p/haiku", "p/sonnet", "p/opus"];

  it("applies a clear pick whose deliberation signal agrees", () => {
    const out = resolveModelDecision({
      answers: { model: choice("p/haiku", 1, { "p/haiku": 1 }), needs_reasoning: noul(0.15) },
      models,
      cheapest: "p/haiku",
    });
    expect(out).toMatchObject({ apply: true, model: "p/haiku" });
  });

  it("refuses the dangerous contradiction: hard step routed to the cheapest model", () => {
    // The failure the operator cannot see — quality lost silently.
    const out = resolveModelDecision({
      answers: { model: choice("p/haiku", 0.99), needs_reasoning: noul(0.9) },
      models,
      cheapest: "p/haiku",
    });
    expect(out).toMatchObject({ apply: false, reason: "signals_disagree" });
  });

  it("allows a mechanical step on an expensive model (a cost miss, not a quality one)", () => {
    const out = resolveModelDecision({
      answers: { model: choice("p/opus", 0.99), needs_reasoning: noul(0.1) },
      models,
      cheapest: "p/haiku",
    });
    expect(out).toMatchObject({ apply: true, model: "p/opus" });
  });

  it("refuses a pick outside the pool and a missing deliberation signal", () => {
    expect(resolveModelDecision({
      answers: { model: choice("p/gpt", 0.99), needs_reasoning: noul(0.9) },
      models,
    }).reason).toBe("no_usable_pick");
    expect(resolveModelDecision({
      answers: { model: choice("p/opus", 0.99) },
      models,
    }).reason).toBe("no_deliberation_signal");
  });
});

describe("resolveToolDecision", () => {
  const tools = ["Bash", "Read", "Edit"];
  const plans = tools.map((name) => ({ name, kind: "function" }));
  const answers = (pick, conf, needs) => ({ tool: choice(pick, conf), needs_tool: noul(needs) });

  it("forces the picked tool when there is no cache to protect", () => {
    expect(resolveToolDecision({ answers: answers("Bash", 0.9, 0.8), tools, plans, cacheSafe: true }))
      .toMatchObject({ mode: "forced", tool: "Bash" });
  });

  it("pins no-tool only when it is safe to mutate tool_choice", () => {
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.9, 0.1), tools, plans, cacheSafe: true }))
      .toMatchObject({ mode: "none" });
  });

  // The cache rule. Mutating tool_choice rewrites the cached prefix; on a 60k
  // prefix at the top tier that costs more than many turns of the saving.
  it("falls back to a tail hint when a cache breakpoint is present", () => {
    expect(resolveToolDecision({ answers: answers("Bash", 0.9, 0.8), tools, plans, cacheSafe: false }))
      .toMatchObject({ mode: "hint", tool: "Bash" });
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.9, 0.1), tools, plans, cacheSafe: false }))
      .toMatchObject({ mode: "passthrough", reason: "cache_breakpoint" });
    // An operator who allows only hints gets no tool_choice mutation anywhere.
    expect(resolveToolDecision({ answers: answers("Bash", 0.9, 0.8), tools, plans, cacheSafe: true, allowed: "hint" }))
      .toMatchObject({ mode: "hint", tool: "Bash" });
    expect(resolveToolDecision({ answers: answers(NO_TOOL, 0.9, 0.1), tools, plans, cacheSafe: true, allowed: "hint" }))
      .toMatchObject({ mode: "passthrough", reason: "mode_not_allowed" });
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
  it("keeps non-tool options out of a model choice", () => {
    // A non-model option in a model question absorbed 39-45% of the probability
    // mass and wrecked the decision.
    const { model } = buildModelQuestions(["p/haiku", "p/opus"], (m) => `brief for ${m}`);
    expect(Object.keys(model.criteria).sort()).toEqual(["p/haiku", "p/opus"]);
    expect(model.criteria).not.toHaveProperty(NO_TOOL);
  });

  it("offers the no-tool escape only in the tool choice", () => {
    const q = buildToolQuestions([{ name: "Bash", description: "runs a command" }]);
    expect(q.tool.criteria).toHaveProperty(NO_TOOL);
    expect(q.needs_tool.type).toBe("noul");
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

describe("resolveCriteria", () => {
  it("prefers the operator's brief, then the curated table, then capabilities", () => {
    expect(resolveCriteria({ provider: "anthropic", model: "claude-opus-5", briefs: { "anthropic/claude-opus-5": "MY BRIEF" } }))
      .toContain("MY BRIEF");
    // Curated: says what the model is FOR.
    expect(resolveCriteria({ provider: "anthropic", model: "claude-opus-5" })).toMatch(/root-cause debugging/i);
    // Unknown model still gets something, and is priced.
    const derived = resolveCriteria({ provider: "openai", model: "gpt-5.6-luna" });
    expect(derived.length).toBeGreaterThan(0);
  });

  it("appends live price so the brief never goes stale", () => {
    expect(resolveCriteria({ provider: "anthropic", model: "claude-opus-5" })).toMatch(/\$\d/);
  });
});

describe("routes", () => {
  it("ships only the Vercel route, reusing the existing gateway credential", () => {
    expect(Object.keys(ROUTES)).toContain("vercel");
    expect(ROUTES.vercel.credentialProvider).toBe("vercel-ai-gateway");
    expect(ROUTES.vercel.model).toBe("typesafe-ai/jev");
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
