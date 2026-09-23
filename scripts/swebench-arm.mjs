#!/usr/bin/env node
// Runs one arm of the routing experiment over the frozen SWE-bench subset.
//
//   node scripts/swebench-arm.mjs --split dev --model kr/claude-sonnet-5 --out /tmp/arm-sonnet
//
// The arm is the model the harness asks for; everything else is identical between
// arms, which is the whole point. A fixed model never reaches the decision router,
// and a combo whose strategy is "auto" does, so the arms need no settings flip.
//
// What the agent sees is the issue text and the repository at its base commit —
// never the gold patch, never the hidden tests. Grading is the official harness in
// a container, not this script.
//
// Env: NINEROUTER_URL, NINEROUTER_KEY, SWEBENCH_DIR (the capped harness checkout).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const SPLIT = arg("split", "dev");
const MODEL = arg("model", null);
const OUT = arg("out", null);
const BASE = (arg("url", process.env.NINEROUTER_URL || "http://127.0.0.1:20127")).replace(/\/+$/, "");
const KEY = arg("key", process.env.NINEROUTER_KEY || "local-only");
const SWEBENCH = arg("swebench", process.env.SWEBENCH_DIR || "/tmp/9router-swebench-pilot");
const WORK = arg("work", "/tmp/9r-swebench-work");
const AGENT_TIMEOUT_S = Number(arg("agent-timeout", "420"));
const LIMIT = Number(arg("limit", "0"));

if (!MODEL || !OUT) {
  console.error("--model and --out are required");
  process.exit(2);
}

// --manifest lets a difficulty screen run over its own candidate pool; the frozen
// subset stays the default so an experiment arm cannot silently drift off it.
const MANIFEST = arg("manifest", "docs/swebench-subset.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
let instances = manifest[SPLIT] ?? manifest[SPLIT === "dev" ? "dev" : "held_out"];
if (!instances) {
  console.error(`manifest ${MANIFEST} has no split ${SPLIT} (has: ${Object.keys(manifest).filter((k) => Array.isArray(manifest[k])).join(", ")})`);
  process.exit(2);
}
if (LIMIT > 0) instances = instances.slice(0, LIMIT);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

/** One blob-less clone per repo, reused across that repo's instances. */
function repoCheckout(repo, baseCommit) {
  const dir = path.join(WORK, repo.replace("/", "__"));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    const cloned = run("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${repo}.git`, dir]);
    if (cloned.status !== 0) return { dir, error: `clone failed: ${(cloned.stderr || "").slice(0, 200)}` };
  }
  // A previous instance left its own edits and commit behind; both have to go or
  // the next instance's diff carries them and grades the wrong change.
  run("git", ["-C", dir, "checkout", "--force", "--detach", baseCommit]);
  const reset = run("git", ["-C", dir, "reset", "--hard", baseCommit]);
  run("git", ["-C", dir, "clean", "-fdx"]);
  if (reset.status !== 0) return { dir, error: `checkout ${baseCommit} failed` };
  const head = run("git", ["-C", dir, "rev-parse", "HEAD"]).stdout.trim();
  if (head !== baseCommit) return { dir, error: `HEAD ${head.slice(0, 12)} != base ${baseCommit.slice(0, 12)}` };
  return { dir, error: null };
}

/** The issue text as the dataset states it, with no hint of the hidden tests. */
async function issueText(instanceId) {
  const cache = path.join(WORK, "issues.json");
  let issues = {};
  try { issues = JSON.parse(fs.readFileSync(cache, "utf8")); } catch { /* first run */ }
  if (issues[instanceId]) return issues[instanceId];
  for (let offset = 0; offset < 500; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=SWE-bench/SWE-bench_Verified&config=default&split=test&offset=${offset}&length=100`;
    const rows = (await (await fetch(url)).json()).rows;
    for (const { row } of rows) issues[row.instance_id] = row.problem_statement;
  }
  fs.writeFileSync(cache, JSON.stringify(issues));
  return issues[instanceId];
}

function runAgent(dir, statement) {
  const env = { ...process.env, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: KEY };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED"]) delete env[key];
  // Outside the checkout on purpose: inside it, `git add -A` sweeps the agent's own
  // config and session log into the graded patch (measured — six .claude-config
  // files rode along in a dev-screening prediction).
  env.CLAUDE_CONFIG_DIR = path.join(WORK, ".claude-config", path.basename(dir));
  const prompt = `${statement}\n\nCorrija esta issue no checkout atual. Nao faca commit. Nao crie nem edite testes. Modifique so o codigo necessario.`;
  const started = Date.now();
  const res = spawnSync("claude", ["-p", prompt, "--model", MODEL, "--permission-mode", "acceptEdits", "--output-format", "text"],
    { cwd: dir, env, timeout: AGENT_TIMEOUT_S * 1000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ms: Date.now() - started, status: res.status, error: res.error?.message || null };
}

/** The agent's change as a patch, with test files dropped: a model that edits the
 *  tests would otherwise grade itself. */
function patchOf(dir) {
  run("git", ["-C", dir, "add", "-A"]);
  const tracked = run("git", ["-C", dir, "diff", "--cached", "--name-only"]).stdout.split("\n").filter(Boolean);
  const testFiles = tracked.filter((f) => /(^|\/)tests?(\/|$)|(^|\/)testing\//.test(f) || /test_[^/]*\.py$|_test\.py$|conftest\.py$/.test(f));
  // Belt and braces for the config dir now living outside the checkout: anything
  // the agent writes about itself is not part of the fix.
  const agentFiles = tracked.filter((f) => f.startsWith(".claude-config/") || f.startsWith(".claude/"));
  const codeFiles = tracked.filter((f) => !testFiles.includes(f) && !agentFiles.includes(f));
  const diff = codeFiles.length
    ? run("git", ["-C", dir, "diff", "--cached", "--binary", "--", ...codeFiles]).stdout
    : "";
  run("git", ["-C", dir, "reset"]);
  return { patch: diff, touchedTests: testFiles };
}

const pad = (v, n) => String(v ?? "").padEnd(n).slice(0, n);
const runs = [];
const predictions = [];

console.log(`swebench-arm → ${BASE} · split=${SPLIT} (${instances.length}) · model="${MODEL}"`);
console.log(`manifest=${MANIFEST} fingerprint=${manifest.fingerprint ?? "(none — screening pool, not a frozen set)"}\n`);
console.log(`${pad("instance", 34)} ${pad("agent", 7)} ${pad("s", 5)} ${pad("patch", 7)} note`);

for (const inst of instances) {
  const { dir, error: checkoutError } = repoCheckout(inst.repo, inst.base_commit);
  if (checkoutError) {
    console.log(`${pad(inst.instance_id, 34)} ${pad("SKIP", 7)} ${pad("-", 5)} ${pad("-", 7)} ${checkoutError}`);
    runs.push({ instance_id: inst.instance_id, infra: checkoutError });
    continue;
  }
  const statement = await issueText(inst.instance_id);
  const startedAt = new Date().toISOString();
  const agent = runAgent(dir, statement);
  const endedAt = new Date().toISOString();
  const { patch, touchedTests } = patchOf(dir);

  // An agent process that died is an infrastructure result, not a model verdict:
  // counting it as a failed fix is how a broken key becomes a quality claim.
  const infra = agent.error || (agent.status !== 0 ? `agent exit ${agent.status}` : null);
  runs.push({
    instance_id: inst.instance_id, repo: inst.repo, model: MODEL,
    ms: agent.ms, startedAt, endedAt, infra,
    patchBytes: patch.length, touchedTests,
  });
  if (patch) predictions.push({ instance_id: inst.instance_id, model_name_or_path: MODEL, model_patch: patch });

  const note = infra || (patch ? (touchedTests.length ? `dropped ${touchedTests.length} test file(s)` : "") : "empty patch");
  console.log(`${pad(inst.instance_id, 34)} ${pad(infra ? "ERR" : "ok", 7)} ${pad(Math.round(agent.ms / 1000), 5)} ${pad(patch.length, 7)} ${note}`);
}

const predPath = path.join(OUT, "predictions.jsonl");
fs.writeFileSync(predPath, predictions.map((p) => JSON.stringify(p)).join("\n") + "\n");
fs.writeFileSync(path.join(OUT, "runs.json"), JSON.stringify({
  split: SPLIT, model: MODEL, fingerprint: manifest.fingerprint, runs,
}, null, 2) + "\n");

const infraCount = runs.filter((r) => r.infra).length;
console.log(`\n${predictions.length}/${instances.length} produced a patch · ${infraCount} infrastructure failure(s)`);
console.log(`predictions → ${predPath}`);

if (!predictions.length) {
  console.log("nothing to grade.");
  process.exit(0);
}

// Grade with the official harness, one container at a time, capped per container.
const runId = `9r-${SPLIT}-${MODEL.replace(/[^a-z0-9]+/gi, "-")}`;
console.log(`\ngrading with the official harness (run-id ${runId}, -j 1)...`);
const evalRes = spawnSync(path.join(SWEBENCH, ".venv/bin/swebench"),
  ["eval", "verified", "-p", predPath, "-j", "1", "--timeout", "900", "--run-id", runId,
    ...instances.flatMap((i) => ["-i", i.instance_id])],
  { cwd: SWEBENCH, encoding: "utf8", stdio: "inherit", maxBuffer: 64 * 1024 * 1024 });

const resultsPath = path.join(SWEBENCH, "logs/evaluation", runId, "results.json");
if (fs.existsSync(resultsPath)) {
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  fs.copyFileSync(resultsPath, path.join(OUT, "results.json"));
  console.log(`\n${MODEL} on ${SPLIT}: resolved ${results.resolved_instances}/${instances.length}` +
    ` · infra(harness) ${results.infra_failure_instances} · errors ${results.error_instances}`);
  console.log(`resolved: ${(results.resolved_ids || []).join(" ") || "none"}`);
} else {
  console.log(`no results.json at ${resultsPath} (eval exit ${evalRes.status})`);
}
