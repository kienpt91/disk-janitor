// Aggregates coverage/coverage-summary.json (vitest v8, json-summary reporter) by architecture layer
// and checks the targets: domain >= 95% lines, application >= 90%, overall >= 85%.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const summary = JSON.parse(readFileSync(resolve(root, "coverage", "coverage-summary.json"), "utf8"));
const layers = ["domain", "application", "infrastructure", "composition", "other"];
const totals = Object.fromEntries(layers.map((l) => [l, { lines: [0, 0], statements: [0, 0], branches: [0, 0], functions: [0, 0] }]));
const all = { lines: [0, 0], statements: [0, 0], branches: [0, 0], functions: [0, 0] };
const files = [];
for (const [file, s] of Object.entries(summary)) {
  if (file === "total") continue;
  const rel = relative(resolve(root, "src"), file).split("\\").join("/");
  const layer = layers.includes(rel.split("/")[0]) ? rel.split("/")[0] : "other";
  files.push({ rel, layer, lines: s.lines });
  for (const k of ["lines", "statements", "branches", "functions"]) {
    totals[layer][k][0] += s[k].covered;
    totals[layer][k][1] += s[k].total;
    all[k][0] += s[k].covered;
    all[k][1] += s[k].total;
  }
}
const pct = ([c, t]) => (t === 0 ? 100 : (100 * c) / t);
const fmt = (v) => v.toFixed(1).padStart(6) + "%";
const targets = { domain: 95, application: 90 };
const rows = [];
let failed = false;
console.log("layer            lines  statements  branches  functions   target");
for (const l of layers) {
  const t = totals[l];
  if (t.lines[1] === 0) continue;
  const target = targets[l];
  const ok = target === undefined || pct(t.lines) >= target;
  if (!ok) failed = true;
  console.log(`${l.padEnd(15)} ${fmt(pct(t.lines))} ${fmt(pct(t.statements)).padStart(10)} ${fmt(pct(t.branches)).padStart(9)} ${fmt(pct(t.functions)).padStart(10)}   ${target ? `>= ${target}% ${ok ? "met" : "MISSED"}` : "-"}`);
}
const overallOk = pct(all.lines) >= 85;
if (!overallOk) failed = true;
console.log(`${"overall".padEnd(15)} ${fmt(pct(all.lines))} ${fmt(pct(all.statements)).padStart(10)} ${fmt(pct(all.branches)).padStart(9)} ${fmt(pct(all.functions)).padStart(10)}   >= 85% ${overallOk ? "met" : "MISSED"}`);
const uncovered = files.filter((f) => f.lines.pct < 80).sort((a, b) => a.lines.pct - b.lines.pct);
if (uncovered.length > 0) {
  console.log("\nfiles below 80% line coverage:");
  for (const f of uncovered) console.log(`  ${f.rel.padEnd(52)} ${f.lines.pct.toFixed(1)}% (${f.lines.covered}/${f.lines.total})`);
}
process.exit(failed ? 1 : 0);
