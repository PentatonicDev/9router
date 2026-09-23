#!/usr/bin/env node
// Offline replay: does jev's model verdict separate tasks the cheap model FAILS from
// tasks it solves? Labels come from graded SWE-bench runs (fixed haiku), never from
// jev itself. Metric is AUC of P(stronger than haiku) against "haiku failed".
//
//   node scripts/jev-replay.mjs <labels.json>      labels: [{instance_id, hard}]
//
// Each variant is one (state builder × criteria) pair asked over the SAME tasks, so
// the comparison is paired. Costs cents: jev is $0.042/M input.

import fs from "node:fs";
import { buildState } from "../open-sse/decision/state.js";
import { buildModelQuestions, MODEL_KEY } from "../open-sse/decision/questions.js";
import { resolveCriteria } from "../open-sse/decision/modelBriefs.js";

const BASE = (process.env.NINEROUTER_URL || "http://127.0.0.1:20127").replace(/\/+$/, "");
const KEY = process.env.NINEROUTER_KEY;
const labels = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const issues = JSON.parse(fs.readFileSync("/tmp/9r-swebench-work/issues.json", "utf8"));
const POOL = ["kr/claude-haiku-4.5", "kr/claude-sonnet-5", "kr/claude-opus-5"];
const CLAUDE_CODE_SYSTEM = fs.readFileSync(process.env.SYSTEM_FILE || "/tmp/9r-cc-system.txt", "utf8");
const PROMPT_TAIL = "\n\nCorrija esta issue no checkout atual. Nao faca commit. Nao crie nem edite testes. Modifique so o codigo necessario.";

// The first turn exactly as Claude Code sends it: a gitStatus reminder, then the task.
const firstTurn = (statement) => ({
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# gitStatus\nCurrent branch: HEAD\nStatus:\n(clean)\n</system-reminder>" },
    { type: "text", text: statement + PROMPT_TAIL },
  ],
});

const current = (model) => {
  const slash = model.indexOf("/");
  return resolveCriteria({ provider: model.slice(0, slash), model: model.slice(slash + 1) });
};

// Tiers written to be mutually exclusive on the one axis that matters here: how
// likely a cheap model is to get this wrong. The current briefs all say "... with
// clear requirements", which gives jev nothing to separate haiku from sonnet on.
const CONTRASTIVE = {
  "kr/claude-haiku-4.5": "Cheapest. Only for a change whose location and fix are already obvious from the request: a named file or function, a clear one-spot edit, a mechanical rename, formatting, a lookup. Fails when the cause must be found first.",
  "kr/claude-sonnet-5": "Mid-tier. For bugs whose cause must be located in an unfamiliar codebase, behaviour spanning several functions or files, or a fix that must preserve existing behaviour and edge cases.",
  "kr/claude-opus-5": "Strongest and most expensive. For subtle bugs in deep library internals: numerical, type-system, parser, concurrency or protocol semantics, or a report whose root cause is far from its symptom.",
};
const criteriaVariants = { current, contrastive: (m) => CONTRASTIVE[m] };

const stateVariants = {
  current: (statement) => buildState({ system: CLAUDE_CODE_SYSTEM, messages: [firstTurn(statement)] }),
  // The harness's own system prompt is identical for every task: zero information,
  // 4000 chars. The gitStatus reminder likewise. What remains is the task.
  clean: (statement) => ({ task: statement }),
};

async function ask(state, criteriaFor) {
  const { questions } = buildModelQuestions(POOL, criteriaFor);
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BASE}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "vercel-ai-gateway/typesafe-ai/jev", state, questions }),
    });
    if (res.ok) {
      const body = await res.json();
      const answer = body.answers?.[MODEL_KEY];
      if (answer?.probabilities) return { p: answer.probabilities, answers: body.answers, tokens: body.usage?.input_tokens || 0 };
    } else if (attempt === 5) console.error(`jev ${res.status}: ${(await res.text()).slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
  }
  return null;
}

/** Mann-Whitney AUC; ties count half. 0.5 is a coin. */
export function auc(scores, positive) {
  let wins = 0, pairs = 0;
  scores.forEach((s, i) => {
    if (!positive[i]) return;
    scores.forEach((t, j) => {
      if (positive[j]) return;
      pairs++;
      wins += s > t ? 1 : s === t ? 0.5 : 0;
    });
  });
  return pairs ? wins / pairs : NaN;
}

const only = (process.env.VARIANTS || "").split(",").filter(Boolean);
const variants = [];
for (const [s, build] of Object.entries(stateVariants))
  for (const [c, criteriaFor] of Object.entries(criteriaVariants))
    if (!only.length || only.includes(`${s}/${c}`)) variants.push({ name: `${s}/${c}`, build, criteriaFor });

const tasks = labels.filter((l) => issues[l.instance_id]);
console.log(`${tasks.length} tasks (${tasks.filter((t) => t.hard).length} hard) · ${variants.length} variants`);

const out = {};
for (const v of variants) {
  // ponytail: 2 in flight. The upstream answers 529 under load, and a dropped row is
  // a biased row, so retries back off exponentially rather than skip.
  const rows = [];
  for (let i = 0; i < tasks.length; i += 2) {
    rows.push(...await Promise.all(tasks.slice(i, i + 2).map(async (t) => {
      const r = await ask(v.build(issues[t.instance_id]), v.criteriaFor);
      return r && { ...t, p: r.p, noul: r.answers?.needs_reasoning?.noul ?? null, up: 1 - (r.p[POOL[0]] ?? 0), top: Math.max(...Object.values(r.p)), tokens: r.tokens };
    })));
  }
  const ok = rows.filter(Boolean);
  const a = auc(ok.map((r) => r.up), ok.map((r) => r.hard));
  const mean = (xs) => xs.reduce((x, y) => x + y, 0) / (xs.length || 1);
  out[v.name] = ok;
  console.log(`${v.name.padEnd(24)} auc ${a.toFixed(3)} · P(up) hard ${mean(ok.filter((r) => r.hard).map((r) => r.up)).toFixed(2)}` +
    ` easy ${mean(ok.filter((r) => !r.hard).map((r) => r.up)).toFixed(2)} · top-p ${mean(ok.map((r) => r.top)).toFixed(2)}` +
    ` · ${Math.round(mean(ok.map((r) => r.tokens)))} tok · n=${ok.length}`);
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
