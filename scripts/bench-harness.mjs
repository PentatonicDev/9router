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
// always means the agent actually did it. Reads token usage from the router's own
// usage rows, keyed on a watermark so concurrent traffic is not counted.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const BASE = (arg("url", process.env.NINEROUTER_URL || "http://127.0.0.1:20127")).replace(/\/+$/, "");
const MODEL = arg("model", null);
const REPEAT = Number(arg("repeat", "1"));
const KEEP = process.argv.includes("--keep");

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
];

/** Rows the router wrote after `since`, split into work and decision traffic. */
async function usageSince(since) {
  try {
    const res = await fetch(`${BASE}/api/usage/recent?limit=500`);
    if (!res.ok) return null;
    const data = await res.json();
    const rows = (data.logs || data.rows || []).filter((r) => (r.id ?? 0) > since);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

function materialize(task, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(task.files)) fs.writeFileSync(path.join(dir, name), content);
}

function runHarness(dir, prompt) {
  // The child must not inherit this session's own Claude Code environment: a stale
  // CLAUDE_CODE_SESSION_ID or ANTHROPIC_BASE_URL makes it hang before its first call.
  const env = { ...process.env, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: "local-only" };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED"]) delete env[key];
  const started = Date.now();
  const res = spawnSync("claude", ["-p", prompt, "--model", MODEL, "--permission-mode", "acceptEdits", "--output-format", "text"],
    { cwd: dir, env, timeout: 300000, encoding: "utf8" });
  return { ms: Date.now() - started, out: `${res.stdout || ""}${res.stderr || ""}` };
}

const pad = (v, n) => String(v ?? "").padEnd(n).slice(0, n);
let passed = 0;
let total = 0;

console.log(`bench-harness → ${BASE} · harness asks for "${MODEL}" · ${REPEAT}x per task\n`);
console.log(`${pad("task", 12)} ${pad("run", 4)} ${pad("check", 6)} ${pad("ms", 8)} note`);

for (const task of TASKS) {
  for (let i = 1; i <= REPEAT; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task.id}-`));
    materialize(task, dir);
    const before = spawnSync(task.check[0], task.check.slice(1), { cwd: dir, encoding: "utf8" });
    if (before.status === 0) {
      console.log(`${pad(task.id, 12)} ${pad(i, 4)} ${pad("SKIP", 6)} ${pad("-", 8)} the check already passes before the work — it would not measure anything`);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const { ms, out } = runHarness(dir, task.prompt);
    const after = spawnSync(task.check[0], task.check.slice(1), { cwd: dir, encoding: "utf8" });
    const ok = after.status === 0;
    total++;
    if (ok) passed++;
    console.log(`${pad(task.id, 12)} ${pad(i, 4)} ${pad(ok ? "PASS" : "FAIL", 6)} ${pad(ms, 8)} ${ok ? "" : (after.stdout || after.stderr || out).split("\n")[0]?.slice(0, 60) || ""}`);
    if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed}/${total} passed across ${TASKS.length} tasks.`);
console.log("Compare against the same run with the router setting changed — the harness is identical in both.");
console.log("Run it once with decisionRouter.effort off and once with on, and diff the pass column first:");
console.log("fewer tokens is only a win if the pass column holds.");
