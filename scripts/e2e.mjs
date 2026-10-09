// Runs Foxpilot end to end in Firefox (scripts/lib/firefox.mjs): opens a task
// page, runs the goal through the panel's run API, and writes a JSON record
// and a screenshot to artifacts/. The JSON holds the RunResult: per-step
// timing, refused decisions and executeScript counts per function. Exit code
// 0 only when the panel verifies the goal.
// Usage: pnpm e2e [flights|maps|walking] [--llm] [--record] [--headless] [--dry-run]
// Env: FIREFOX (binary path), GOAL and URL (a custom task).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { distOf, FIREFOX, format, launch, preflight, root } from "./lib/firefox.mjs";

const app = "foxpilot";
const TASKS = {
  flights: ["https://www.google.com/travel/flights?hl=en", "Find a one-way ticket from New York to San Francisco on October 9, 2026."],
  maps: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate."],
  walking: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate. Select Walking."],
};
const args = process.argv.slice(2);
const task = args.find((a) => !a.startsWith("--")) ?? "flights";
const useLlm = args.includes("--llm");
const recording = args.includes("--record");
const headless = args.includes("--headless");
const [url, goal] = process.env.GOAL ? [process.env.URL ?? TASKS.flights[0], process.env.GOAL] : TASKS[task] ?? [];
if (!goal) {
  console.error(`Unknown task "${task}". Use one of: ${Object.keys(TASKS).join(", ")}.`);
  process.exit(2);
}
if (args.includes("--dry-run")) {
  const dist = distOf(app);
  console.log(JSON.stringify({ firefox: FIREFOX, firefoxFound: existsSync(FIREFOX), dist, distBuilt: existsSync(join(dist, "manifest.json")), task, url, goal, useLlm, headless }, null, 1));
  process.exit(0);
}
const missing = preflight({ app });
if (missing) {
  console.error(missing);
  process.exit(2);
}

const git = (...a) => { try { return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(root, "artifacts");
mkdirSync(out, { recursive: true });
const base = join(out, `${task}-${stamp}`);

const started = Date.now();
const record = { task, goal, url, llm: useLlm, gitSha: git("rev-parse", "HEAD"), steps: [], checks: [], verified: false };
let failure = null;
let session = null;
try {
  session = await launch({ app, headless });
  record.firefox = await session.version();
  const tabId = await session.openTask(url);
  ({ modelLoadMs: record.modelLoadMs } = await session.ready());
  console.log(`gliner: loaded in ${(record.modelLoadMs / 1000).toFixed(1)} s`);
  const result = await session.run(goal, { tabId, llm: useLlm, record: recording });
  // The task's url stays the record's url; where the run ended is finalUrl.
  Object.assign(record, result, { url, finalUrl: result.url });
  record.states = await session.states().catch((e) => `unread: ${e.message}`);
  for (const line of format(result)) console.log(line);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  record.error = failure;
}
if (session) await session.screenshot(`${base}.png`).catch((e) => console.log("screenshot:", e.message));
record.passed = record.verified && !failure;
record.wallMs = Date.now() - started;
writeFileSync(`${base}.json`, JSON.stringify(record, null, 2));
await session?.close();
console.log(`${record.passed ? "PASS" : "FAIL"} ${task}${failure ? `: ${failure}` : ""} | ${base}.json`);
process.exit(record.passed ? 0 : 1);
