#!/usr/bin/env node
// Joins what the client measured (did the work get DONE) with what only the router
// can see (what it spent doing it), for two arms of the same experiment.
//
//   node scripts/bench-report.mjs --control /tmp/arm-control.json --routed /tmp/arm-routed.json
//
// The join is each run's own wall-clock window: the harness records startedAt/endedAt
// per task, and every usage row inside that window belongs to that run. Attributing
// by model instead would mix the arms, because the routed arm serves some turns on
// the very model the control arm pins.
//
// ponytail: a Wilson interval on 3-6 tasks is wide by construction and says so.
// At this N the honest claim is the cost ratio, not a quality difference.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const DB = arg("db", path.join(os.homedir(), ".9router", "db", "data.sqlite"));
const arms = [["control", arg("control", null)], ["routed", arg("routed", null)]]
  .filter(([, file]) => file);
if (!arms.length) {
  console.error("--control and/or --routed report file is required (bench-harness --report)");
  process.exit(2);
}

/** node:sqlite is in Node >=22.5; the DB is read-only here either way. */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(DB, { readOnly: true });

/** Usage rows whose timestamp falls inside a run's window. */
const rowsFor = (startedAt, endedAt) => db
  .prepare("select provider, model, endpoint, promptTokens, completionTokens, cost, tokens, meta from usageHistory where timestamp >= ? and timestamp <= ?")
  .all(startedAt, endedAt);

const parse = (raw) => { try { return JSON.parse(raw || "{}"); } catch { return {}; } };

/** Wilson score interval: the small-N convention, and it never leaves [0,1]. */
function wilson(passed, total, z = 1.96) {
  if (!total) return [0, 0];
  const p = passed / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

const summaries = [];
for (const [label, file] of arms) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  let chat = 0, decision = 0, chatIn = 0, chatOut = 0, decisionCalls = 0, applied = 0, verdicts = 0;
  const servedBy = new Map();

  for (const run of report.runs) {
    for (const row of rowsFor(run.startedAt, run.endedAt)) {
      if (row.endpoint === "decision") {
        decision += row.cost || 0;
        decisionCalls++;
        const meta = parse(row.meta);
        if (meta.kind === "model") { verdicts++; if (meta.apply) applied++; }
        continue;
      }
      chat += row.cost || 0;
      chatIn += row.promptTokens || 0;
      chatOut += row.completionTokens || 0;
      const key = `${row.provider}/${row.model}`;
      servedBy.set(key, (servedBy.get(key) || 0) + 1);
    }
  }

  const [lo, hi] = wilson(report.passed, report.total);
  const totalCost = chat + decision;
  summaries.push({
    label, model: report.model, passed: report.passed, total: report.total,
    lo, hi, chat, decision, totalCost, chatIn, chatOut, decisionCalls, verdicts, applied,
    perSolved: report.passed ? totalCost / report.passed : null,
    ms: report.runs.reduce((sum, r) => sum + (r.ms || 0), 0),
    servedBy: [...servedBy.entries()].sort((a, b) => b[1] - a[1]),
  });
}

const money = (v) => `$${v.toFixed(5)}`;
const pad = (v, n) => String(v ?? "").padEnd(n);

console.log(`\n${pad("arm", 9)} ${pad("model", 22)} ${pad("pass", 7)} ${pad("95% CI", 14)} ${pad("chat", 11)} ${pad("decide", 10)} ${pad("total", 11)} ${pad("$/solved", 11)} wall`);
for (const s of summaries) {
  console.log(
    `${pad(s.label, 9)} ${pad(s.model, 22)} ${pad(`${s.passed}/${s.total}`, 7)} ` +
    `${pad(`${(s.lo * 100).toFixed(0)}–${(s.hi * 100).toFixed(0)}%`, 14)} ${pad(money(s.chat), 11)} ` +
    `${pad(money(s.decision), 10)} ${pad(money(s.totalCost), 11)} ` +
    `${pad(s.perSolved === null ? "—" : money(s.perSolved), 11)} ${(s.ms / 1000).toFixed(1)}s`
  );
}

for (const s of summaries) {
  console.log(`\n[${s.label}] served by:`);
  for (const [model, calls] of s.servedBy) console.log(`  ${pad(model, 40)} ${calls} calls`);
  console.log(`  input ${s.chatIn} tok · output ${s.chatOut} tok`);
  if (s.decisionCalls) {
    const share = s.totalCost ? (s.decision / s.totalCost) * 100 : 0;
    console.log(`  decision: ${s.decisionCalls} calls, ${s.applied}/${s.verdicts} verdicts applied, ${share.toFixed(2)}% of spend`);
  }
}

const [a, b] = summaries;
if (a && b && a.totalCost > 0) {
  const delta = ((b.totalCost - a.totalCost) / a.totalCost) * 100;
  console.log(`\ncost ${b.label} vs ${a.label}: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`);
  const overlap = b.lo <= a.hi && a.lo <= b.hi;
  console.log(overlap
    ? `pass rates: intervals overlap at n=${a.total}/${b.total} — this run cannot separate quality, only cost.`
    : `pass rates: intervals are disjoint (${a.passed}/${a.total} vs ${b.passed}/${b.total}).`);
}

db.close();
