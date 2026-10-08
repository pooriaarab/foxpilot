// Writes the zoo-sites benchmark as JSON and as a Markdown table. The JSON is
// the record; the Markdown is made from it and from nothing else.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const median = (values) => {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const cell = (v) => (v === null || v === undefined ? "-" : String(v).replace(/\|/g, "\\|").replace(/\s+/g, " "));

// Each skipped task counts as `repeat` attempts in the "over all" rate, so both
// rates count attempts.
export function summarize(rows, repeat) {
  const attempts = rows.filter((r) => r.status !== "skipped");
  const passes = attempts.filter((r) => r.status === "pass").length;
  const skipped = rows.filter((r) => r.status === "skipped");
  const reasons = {};
  for (const r of skipped) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return {
    tasks: new Set(rows.map((r) => r.id)).size,
    attemptedTasks: new Set(attempts.map((r) => r.id)).size,
    attempts: attempts.length,
    passes,
    skippedTasks: skipped.length,
    skippedByReason: reasons,
    passRateAttempted: attempts.length ? passes / attempts.length : null,
    passRateAll: passes / (attempts.length + skipped.length * repeat || 1),
    medianWallMs: median(attempts.map((r) => r.wallMs)),
    medianModelMs: median(attempts.map((r) => r.modelMs)),
    extractorCostUsd: Math.round(attempts.reduce((s, r) => s + (r.extractorCostUsd ?? 0), 0) * 10000) / 10000,
  };
}

export function writeReport(outDir, meta, rows) {
  const summary = summarize(rows, meta.repeat);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "zoo-sites.json");
  const mdPath = join(outDir, "zoo-sites.md");
  writeFileSync(jsonPath, JSON.stringify({ meta, summary, rows }, null, 1) + "\n");
  const s = summary;
  const attempts = rows.filter((r) => r.status !== "skipped");
  const skipped = rows.filter((r) => r.status === "skipped");
  const lines = [
    "# foxpilot on zoo-sites",
    "",
    `foxpilot runs the [zoo-sites](https://github.com/bgrins/zoo-sites) browser-agent eval (Apache-2.0).`,
    `zoo-sites' own validators grade every attempt, against what its server observed. foxpilot's own checklist does not grade.`,
    "",
    `- zoo-sites commit: \`${meta.zooCommit ?? "unknown"}\``,
    `- foxpilot commit: \`${meta.foxpilotCommit ?? "unknown"}\``,
    `- Date: ${meta.date}`,
    `- Command: \`${meta.command}\``,
    `- Repeats: ${meta.repeat}. LLM: ${meta.llm ? "on" : "off"}.`,
    `- Extractor: ${meta.extractor ? `on (${meta.extractorModel}, paid; this run cost $${s.extractorCostUsd})` : "off. Tasks graded on typed answer fields are skipped."}`,
    "",
    "## Summary",
    "",
    "| tasks | attempted | attempts | pass | pass rate (attempted) | pass rate (all) | median wall ms | median model ms |",
    "|---|---|---|---|---|---|---|---|",
    `| ${s.tasks} | ${s.attemptedTasks} | ${s.attempts} | ${s.passes} | ${pct(s.passes, s.attempts)} | ${(100 * s.passRateAll).toFixed(1)}% | ${cell(s.medianWallMs)} | ${cell(s.medianModelMs)} |`,
    "",
    "## Attempts",
    "",
    "| task | family | rep | status | wall ms | steps | model ms | detail |",
    "|---|---|---|---|---|---|---|---|",
    ...attempts.map((r) => `| ${r.id} | ${r.family} | ${r.rep} | ${r.status} | ${cell(r.wallMs)} | ${cell(r.steps)} | ${cell(r.modelMs)} | ${cell(r.error ?? r.detail)} |`),
    "",
    "## Skipped",
    "",
    "| reason | tasks |",
    "|---|---|",
    ...Object.entries(s.skippedByReason).map(([reason, n]) => `| ${reason} | ${n} |`),
    "",
    "| task | family | reason |",
    "|---|---|---|",
    ...skipped.map((r) => `| ${r.id} | ${r.family} | ${r.reason} |`),
    "",
  ];
  writeFileSync(mdPath, lines.join("\n"));
  return { jsonPath, mdPath, summary };
}
