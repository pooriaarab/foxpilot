// Runs foxpilot over the zoo-sites eval and writes docs/benchmarks/zoo-sites.md
// and zoo-sites.json. zoo-sites' validators grade each attempt (scripts/zoo/zoo.mjs).
// Usage: pnpm eval --zoo <zoo-sites checkout> [--tasks a,b]
//        [--repeat N] [--limit N] [--extractor] [--llm] [--seed S] [--out DIR] [--dry-run]
// --extractor turns on zoo-sites' answer extractor, a paid model call per
// graded answer (claude-haiku-4-5 by default; EVAL_EXTRACTOR=codex selects Codex).
// --dry-run lists the task inventory and starts no Firefox.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grade, inventory, openZoo, resetFor } from "./zoo.mjs";
import { writeReport } from "./report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const zooPath = flag("--zoo");
if (!zooPath) {
  console.error("Usage: node scripts/zoo/cli.mjs --zoo <zoo-sites checkout> [--tasks a,b] [--repeat N] [--limit N] [--extractor] [--llm] [--dry-run]");
  process.exit(2);
}
const only = flag("--tasks")?.split(",").filter(Boolean) ?? null;
const repeat = Number(flag("--repeat") ?? 1);
const limit = flag("--limit") === null ? Infinity : Number(flag("--limit"));
const extractor = args.includes("--extractor");
const llm = args.includes("--llm");
const outDir = flag("--out") ?? join(root, "docs", "benchmarks");

const zoo = await openZoo(zooPath, { seed: flag("--seed") });
let entries = inventory(zoo, { extractor });
if (only) {
  const unknown = only.filter((id) => !entries.some((e) => e.id === id));
  if (unknown.length) {
    await zoo.close();
    console.error(`Unknown zoo-sites task: ${unknown.join(", ")}`);
    process.exit(2);
  }
  entries = entries.filter((e) => only.includes(e.id));
}
const attemptable = entries.filter((e) => !e.skipped).slice(0, limit);
entries = entries.filter((e) => e.skipped || attemptable.includes(e));

if (args.includes("--dry-run")) {
  for (const e of entries) console.log(`${e.skipped ? "skip" : "run "}  ${e.id.padEnd(22)} ${e.grading.padEnd(6)} ${e.skipped ?? e.goal}`);
  console.log(`${attemptable.length} to run, ${entries.length - attemptable.length} skipped, of ${entries.length}`);
  await zoo.close();
  process.exit(0);
}

const { launch } = await import("../lib/firefox.mjs");
const session = await launch();
const rows = entries.filter((e) => e.skipped).map((e) => ({ id: e.id, family: e.family, status: "skipped", reason: e.skipped }));
try {
  for (const entry of attemptable) {
    for (let rep = 1; rep <= repeat; rep++) {
      resetFor(zoo, entry);
      const started = Date.now();
      let result = null;
      let error = null;
      try {
        const tabId = await session.openTask(entry.url);
        result = await session.run(entry.goal, { tabId, llm });
      } catch (e) {
        error = String(e?.message ?? e);
      }
      const wallMs = Date.now() - started;
      const verdict = await grade(zoo, entry, { answer: result?.answer?.text ?? null, extractor });
      const row = {
        id: entry.id,
        family: entry.family,
        rep,
        status: verdict.pass ? "pass" : "fail",
        url: entry.url,
        goal: entry.goal,
        grading: entry.grading,
        wallMs,
        totalMs: result?.totalMs ?? null,
        steps: result?.steps?.length ?? null,
        modelMs: result?.steps ? Math.round(result.steps.reduce((sum, step) => sum + (step.timing?.model ?? 0), 0)) : null,
        foxpilotVerified: result?.verified ?? null,
        answer: result?.answer?.text ?? null,
        fields: verdict.fields,
        detail: verdict.detail,
        extractorCostUsd: verdict.extraction?.cost_usd ?? null,
        ...(verdict.extraction?.error ? { extractorError: verdict.extraction.error } : {}),
        ...(error ? { error } : {}),
      };
      rows.push(row);
      console.log(`${row.status.toUpperCase()}  ${entry.id} r${rep}  ${wallMs} ms  ${row.error ?? row.detail ?? ""}`);
    }
  }
} finally {
  await session.close();
  await zoo.close();
}

const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
const meta = {
  date: new Date().toISOString(),
  command: `pnpm eval ${args.join(" ")}`,
  zooCommit: zoo.commit,
  foxpilotCommit: git("rev-parse", "HEAD"),
  repeat,
  llm,
  extractor,
  extractorModel: extractor ? zoo.extract.extractorInfo().model : null,
};
const { mdPath, jsonPath, summary } = writeReport(outDir, meta, rows);
console.log(`${summary.passes}/${summary.attempts} passed. Wrote ${mdPath} and ${jsonPath}.`);
process.exit(0);
