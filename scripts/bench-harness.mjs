#!/usr/bin/env node
// Measures a real agent harness against a running 9Router, end to end.
//
// The point is that NOTHING changes in the harness. You point it at the router and
// every routing decision — which model, how much reasoning — happens server-side, so
// two runs of this script compare two router settings and nothing else.
//
// Usage:
//   node scripts/bench-harness.mjs --model br-tiered
//   node scripts/bench-harness.mjs --model br-tiered --repeat 3
//
// Env: NINEROUTER_URL (default http://127.0.0.1:20127)
//
// Each task ships with a check that FAILS before the work is done, so "passed"
// always means the agent actually did it. This measures whether the work got DONE;
// token and cost comparisons come from the router's own usage view, because the
// client cannot see what the router spent on its behalf.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const BASE = (arg("url", process.env.NINEROUTER_URL || "http://127.0.0.1:20127")).replace(/\/+$/, "");
const MODEL = arg("model", null);
// The router answers 401 when requireApiKey is on, and the harness's own key is
// what attributes every usage row to this run.
const KEY = arg("key", process.env.NINEROUTER_KEY || "local-only");
const REPEAT = Number(arg("repeat", "1"));
const KEEP = process.argv.includes("--keep");
const REPORT = arg("report", null);
// Comma-separated task ids, so a discrimination screen can run one task per model.
const ONLY = arg("only", null)?.split(",") ?? null;

if (!MODEL) {
  console.error("--model is required (the combo name the harness should ask for)");
  process.exit(2);
}

/** Each task: the prompt, and a check that must fail before and pass after. */
const TASKS = [
  {
    id: "t1-rename",
    prompt: "Leia os arquivos deste diretorio e renomeie a funcao usrNm para userName em legacy.js. Nao mude nada mais.",
    files: { "legacy.js": "export function usrNm(x) { return String(x).trim(); }\nexport function other(a) { return a; }\n", "utils.js": "export function soma(a, b) { return a + b; }\n" },
    check: ["sh", "-c", "grep -q 'function userName' legacy.js && ! grep -q usrNm legacy.js"],
  },
  {
    id: "t2-bug",
    prompt: "cart.js tem um bug em applyDiscount. Leia cart.js e check.js, descubra a regra correta e corrija cart.js ate 'node check.js' passar.",
    files: {
      "cart.js": "// applyDiscount deve devolver total * (1 - pct/100) arredondado a 2 casas.\nexport function applyDiscount(total, pct) {\n  return total * (1 - pct);\n}\n",
      "check.js": 'import { applyDiscount } from "./cart.js";\nfor (const [t, p, want] of [[100, 10, 90], [50, 50, 25], [19.99, 5, 18.99]]) {\n  const got = applyDiscount(t, p);\n  if (got !== want) { console.log(`FAIL: applyDiscount(${t},${p}) = ${got}, esperado ${want}`); process.exit(1); }\n}\nconsole.log("OK");\n',
      "package.json": '{"type":"module"}\n',
    },
    check: ["node", "check.js"],
  },
  {
    id: "t3-impl",
    prompt: "Implemente a funcao slugify em slug.js seguindo a especificacao do comentario. Leia check.js para o comportamento exato e rode 'node check.js' ate passar.",
    files: {
      "slug.js": "// slugify(text): minusculas, espacos viram '-', remove tudo que nao for [a-z0-9-]\nexport function slugify(text) {\n  throw new Error(\"nao implementado\");\n}\n",
      "check.js": 'import { slugify } from "./slug.js";\nconst cases = [["Hello World", "hello-world"], ["  A  B  ", "a-b"], ["Caf\\u00e9 & Bar!", "caf-bar"], ["", ""]];\nfor (const [input, want] of cases) {\n  let got;\n  try { got = slugify(input); } catch (e) { console.log(`FAIL: slugify(${JSON.stringify(input)}) lancou: ${e.message}`); process.exit(1); }\n  if (got !== want) { console.log(`FAIL: slugify(${JSON.stringify(input)}) = ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`); process.exit(1); }\n}\nconsole.log("OK");\n',
      "package.json": '{"type":"module"}\n',
    },
    check: ["node", "check.js"],
  },
  {
    // Candidate discriminating task: right-associative ** and unary minus binding
    // looser than ** are the rules a quick parser gets wrong. Only counts as a
    // quality probe once fixed-model runs show haiku failing and sonnet passing.
    id: "t4-expr",
    prompt: "Implemente a funcao evaluate em expr.js: um avaliador de expressoes aritmeticas. Leia check.js para o comportamento exato e rode 'node check.js' ate passar. Nao execute codigo dinamicamente.",
    files: {
      "expr.js": "// evaluate(src): avalia uma expressao aritmetica e devolve um number.\n// Operadores: + - * / % ** e parenteses. Menos unario permitido.\nexport function evaluate(src) {\n  throw new Error(\"nao implementado\");\n}\n",
      "check.js": 'import fs from "node:fs";\nimport { evaluate } from "./expr.js";\nconst cases = [["1+2*3", 7], ["(1+2)*3", 9], ["2**3**2", 512], ["-2**2", -4], ["10%4", 2], ["8/2/2", 2], ["2*-3", -6], ["-(3+4)", -7], ["2**-1", 0.5], ["1-2-3", -4]];\nfor (const [src, want] of cases) {\n  let got;\n  try { got = evaluate(src); } catch (e) { console.log(`FAIL: evaluate(${JSON.stringify(src)}) lancou: ${e.message}`); process.exit(1); }\n  if (got !== want) { console.log(`FAIL: evaluate(${JSON.stringify(src)}) = ${got}, esperado ${want}`); process.exit(1); }\n}\nconst code = fs.readFileSync("expr.js", "utf8").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "").replace(/\\/\\/.*$/gm, "");\nif (/\\beval\\s*\\(|\\bFunction\\s*\\(/.test(code)) { console.log("FAIL: executou codigo dinamicamente"); process.exit(1); }\nconsole.log("OK");\n',
      "package.json": '{"type":"module"}\n',
    },
    check: ["node", "check.js"],
  },
];

function materialize(task, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(task.files)) fs.writeFileSync(path.join(dir, name), content);
}

function runHarness(dir, prompt) {
  // The child must not inherit this session's own Claude Code environment: a stale
  // CLAUDE_CODE_SESSION_ID or ANTHROPIC_BASE_URL makes it hang before its first call.
  const env = { ...process.env, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: KEY };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED"]) delete env[key];
  // And it must not read or write the operator's own config. Without this the child
  // picks up whatever model overrides that config carries — measured, it resolved a
  // request to a provider with no credentials and every task failed — and it would
  // write session history into the operator's real config dir.
  env.CLAUDE_CONFIG_DIR = path.join(dir, ".claude-config");
  const started = Date.now();
  const res = spawnSync("claude", ["-p", prompt, "--model", MODEL, "--permission-mode", "acceptEdits", "--output-format", "text"],
    { cwd: dir, env, timeout: 300000, encoding: "utf8" });
  return { ms: Date.now() - started, status: res.status, error: res.error?.message || null, out: `${res.stdout || ""}${res.stderr || ""}` };
}

const pad = (v, n) => String(v ?? "").padEnd(n).slice(0, n);
let passed = 0;
let total = 0;
// Each run's wall-clock window, so the analysis step can attribute the router's own
// usage rows to the run that caused them. The client cannot see what the router
// spent on its behalf, and a pass rate without its cost is half the measurement.
const runs = [];

console.log(`bench-harness → ${BASE} · harness asks for "${MODEL}" · ${REPEAT}x per task\n`);
console.log(`${pad("task", 12)} ${pad("run", 4)} ${pad("check", 6)} ${pad("ms", 8)} note`);

for (const task of TASKS.filter((t) => !ONLY || ONLY.includes(t.id))) {
  for (let i = 1; i <= REPEAT; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task.id}-`));
    materialize(task, dir);
    const before = spawnSync(task.check[0], task.check.slice(1), { cwd: dir, encoding: "utf8" });
    if (before.status === 0) {
      console.log(`${pad(task.id, 12)} ${pad(i, 4)} ${pad("SKIP", 6)} ${pad("-", 8)} the check already passes before the work — it would not measure anything`);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const checks = ["check.js", "package.json"].filter((name) => Object.hasOwn(task.files, name));
    const digest = (name) => {
      try { return createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"); }
      catch { return null; }
    };
    const originalChecks = checks.map(digest);
    const startedAt = new Date().toISOString();
    const { ms, out, status, error } = runHarness(dir, task.prompt);
    const endedAt = new Date().toISOString();
    const checkIntact = checks.every((name, index) => digest(name) === originalChecks[index]);
    const after = checkIntact ? spawnSync(task.check[0], task.check.slice(1), { cwd: dir, encoding: "utf8" }) : null;
    const ok = status === 0 && !error && checkIntact && after?.status === 0;
    const failure = error || (status !== 0 ? `claude exit ${status}` : !checkIntact ? "check altered" : (after?.stdout || after?.stderr || out).split("\n")[0]?.slice(0, 60) || "check failed");
    total++;
    if (ok) passed++;
    runs.push({ task: task.id, run: i, model: MODEL, ok, ms, startedAt, endedAt, status, error, checkIntact });
    console.log(`${pad(task.id, 12)} ${pad(i, 4)} ${pad(ok ? "PASS" : "FAIL", 6)} ${pad(ms, 8)} ${ok ? "" : failure}`);
    if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed}/${total} passed across ${ONLY ? TASKS.filter((task) => ONLY.includes(task.id)).length : TASKS.length} tasks.`);
if (REPORT) {
  fs.writeFileSync(REPORT, JSON.stringify({ model: MODEL, base: BASE, passed, total, runs }, null, 2));
  console.log(`report → ${REPORT}`);
}
console.log("Compare against the same run with the router setting changed — the harness is identical in both.");
console.log("A fixed model and an auto combo are two arms of the same experiment: only a combo whose");
console.log("strategy is \"auto\" reaches the decision router, so both can run without touching settings.");
console.log("Diff the pass column first: fewer tokens is only a win if the pass column holds.");
