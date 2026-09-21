#!/usr/bin/env node
// Bench for System One decision routing.
//
// Two things to measure, and both are here because neither is visible from the
// code: whether jev routes a task to the right tier, and whether that helps or
// hurts once the prompt cache is in play. The jev-gateway's own benchmark found
// routing made some models WORSE on feature work, so the only honest way to turn
// this on is to measure it on your own work first — which is what `shadow` mode
// and this script exist for.
//
// Usage:
//   node scripts/bench-jev.mjs --combo my-auto-combo
//   node scripts/bench-jev.mjs --combo my-auto-combo --session
//   node scripts/bench-jev.mjs --combo my-auto-combo --url http://localhost:20128
//
// Env: NINEROUTER_URL (default http://localhost:20128), NINEROUTER_KEY (optional)
//
// Run it once with decisionRouter.mode = "off" and once with "enforce" to get the
// A/B. With "shadow" the gateway decides, logs and prices but applies nothing —
// compare those log lines against what actually served the request.

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = (flag("url", process.env.NINEROUTER_URL || "http://localhost:20128")).replace(/\/+$/, "");
const KEY = flag("key", process.env.NINEROUTER_KEY || "");
const COMBO = flag("combo", null);
const MODEL = flag("model", COMBO || "claude-sonnet-5");
const SESSION = has("session");
const TIMEOUT_MS = Number(flag("timeout", "120000"));

/**
 * A session that hardens, which is the case auto-combo is for: turn 1 is
 * mechanical, turn 2 is ordinary feature work, turn 3 is the kind of bug that
 * needs a reasoning model. A router worth having tracks that; one that does not
 * will either sit on the cheap model or flip back and forth.
 */
const SESSION_TURNS = [
  "renomeia a variavel usrNm pra userName no arquivo utils.js e roda o lint",
  "ok, agora implementa o endpoint de exportacao CSV com paginacao e escreve os testes",
  "os testes passam local mas em producao a exportacao trava com muitos registros e a memoria do worker sobe sem parar, nao acontece em staging",
];

/** Independent tasks, one per complexity tier — for the no-session A/B. */
const SINGLE_TASKS = [
  { tier: "mechanical", text: "adiciona um console.log no inicio da funcao main e roda o lint" },
  { tier: "mechanical", text: "renomeia o arquivo helpers.js pra utils.js e ajusta os imports" },
  { tier: "feature", text: "implementa paginacao no endpoint de listagem de usuarios, com testes" },
  { tier: "feature", text: "refatora o modulo de configuracao pra ler de variaveis de ambiente" },
  { tier: "hard", text: "em producao os jobs de sync perdem mensagens de forma intermitente sob carga, suspeito de race entre o consumer e o commit do offset" },
  { tier: "hard", text: "tem um memory leak no worker que so aparece depois de horas rodando, o heap cresce devagar e nunca cai" },
  { tier: "vague", text: "da uma olhada nisso aqui e ve se ta bom" },
];

async function call(messages) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      },
      body: JSON.stringify({ model: MODEL, messages, stream: false, max_tokens: 64 }),
      signal: controller.signal,
    });
    const text = await response.text();
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, latencyMs, error: `${response.status} ${text.slice(0, 200)}` };
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, latencyMs, error: `unparseable response: ${text.slice(0, 120)}` };
    }
    return {
      ok: true,
      latencyMs,
      // The serving model is the observable: it is what the decision changes.
      served: payload.model || "(not echoed)",
      usage: payload.usage || {},
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

const pad = (v, n) => String(v ?? "").padEnd(n).slice(0, n);
const num = (v) => (typeof v === "number" ? v : 0);

function report(rows, title) {
  const models = [...new Set(rows.map((r) => r.served).filter(Boolean))];
  console.log(`\n${title}`);
  console.log("─".repeat(96));
  console.log(`${pad("task", 12)} ${pad("served model", 34)} ${pad("latency", 10)} ${pad("in", 8)} ${pad("out", 6)} note`);
  for (const r of rows) {
    console.log(
      `${pad(r.label, 12)} ${pad(r.served || "-", 34)} ${pad(`${r.latencyMs}ms`, 10)} ` +
        `${pad(num(r.usage?.prompt_tokens), 8)} ${pad(num(r.usage?.completion_tokens), 6)} ${r.error || ""}`
    );
  }
  console.log("─".repeat(96));
  const ok = rows.filter((r) => r.ok);
  const totalIn = ok.reduce((s, r) => s + num(r.usage?.prompt_tokens), 0);
  const totalOut = ok.reduce((s, r) => s + num(r.usage?.completion_tokens), 0);
  const avg = ok.length ? Math.round(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length) : 0;
  console.log(
    `${ok.length}/${rows.length} ok · in ${totalIn} · out ${totalOut} · avg ${avg}ms · ` +
      `models used: ${models.length ? models.join(", ") : "-"}`
  );
  return { totalIn, totalOut, avg, models, failures: rows.length - ok.length };
}

async function main() {
  console.log(`bench-jev → ${BASE} · model/combo "${MODEL}" · ${SESSION ? "session mode" : "independent tasks"}`);
  console.log("Run once with decisionRouter.mode=off and once with enforce to compare.\n");

  if (SESSION) {
    const rows = [];
    const conversation = [];
    for (const [i, turn] of SESSION_TURNS.entries()) {
      conversation.push({ role: "user", content: turn });
      const result = await call(conversation);
      rows.push({ label: `turn ${i + 1}`, ...result });
      // A placeholder assistant turn keeps the shape a real session would send.
      conversation.push({ role: "assistant", content: result.ok ? "(work done)" : "(failed)" });
    }
    const totals = report(rows, "Escalation ladder — does the router follow the task hardening?");
    console.log(
      "\nWhat to look for: turn 1 on the cheapest model, turn 3 on a reasoning model, and no\n" +
        "flip-flopping. With mode=off every turn lands on the same model — that is the baseline."
    );
    process.exit(totals.failures === rows.length ? 1 : 0);
  }

  const rows = [];
  for (const task of SINGLE_TASKS) {
    const result = await call([{ role: "user", content: task.text }]);
    rows.push({ label: task.tier, ...result });
  }
  report(rows, "Independent tasks — is the tier matched to the task?");

  const byTier = {};
  for (const [i, r] of rows.entries()) {
    const tier = SINGLE_TASKS[i].tier;
    (byTier[tier] ||= new Set()).add(r.served);
  }
  console.log("\nmodels seen per tier (more than one per tier = unstable routing):");
  for (const [tier, set] of Object.entries(byTier)) {
    console.log(`  ${pad(tier, 12)} ${[...set].join(", ") || "-"}${set.size > 1 ? "   ← unstable" : ""}`);
  }
  console.log(
    "\nThen compare total tokens and avg latency against the mode=off run. A router that\n" +
      "picks well but costs more than it saves is a regression, not a feature."
  );
}

main().catch((error) => {
  console.error(`bench-jev failed: ${error.message}`);
  process.exit(1);
});
