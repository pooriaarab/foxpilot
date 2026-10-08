#!/usr/bin/env node
// foxpilot CLI: runs goals in Firefox with the built extension (pnpm build).
//   foxpilot run --url <u> --goal <g> [--llm] [--json] [--headless]
//   foxpilot run --file tasks.jsonl [--llm] [--json] [--headless]
// A file holds one {"url", "goal"} per line; all of them run in one Firefox
// session, so the model loads once. --json prints one RunResult per line.
// Exit code 0 only when every goal is verified on its page.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { format, launch, preflight } from "../scripts/lib/firefox.mjs";

const USAGE = "Usage: foxpilot run (--url <url> --goal <goal> | --file <tasks.jsonl>) [--llm] [--json] [--headless]";
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" }, goal: { type: "string" }, file: { type: "string" },
      llm: { type: "boolean" }, json: { type: "boolean" }, headless: { type: "boolean" },
    },
  });
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
const { positionals: [command], values: options } = parsed;
const tasks = options.file
  ? readFileSync(options.file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
  : [{ url: options.url, goal: options.goal }];
if (command !== "run" || !tasks.length || tasks.some((t) => !t.url || !t.goal)) {
  console.error(USAGE);
  process.exit(2);
}
const missing = preflight();
if (missing) {
  console.error(missing);
  process.exit(2);
}

const session = await launch({ headless: options.headless });
let passed = true;
try {
  // Progress goes to stderr, so --json output stays clean.
  const { modelLoadMs } = await session.ready();
  console.error(`model loaded in ${(modelLoadMs / 1000).toFixed(1)} s`);
  for (const { url, goal } of tasks) {
    const tabId = await session.openTask(url);
    const result = await session.run(goal, { tabId, llm: Boolean(options.llm) });
    passed &&= result.verified;
    console.log(options.json ? JSON.stringify(result) : format(result).join("\n"));
  }
} catch (error) {
  passed = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await session.close();
}
process.exit(passed ? 0 : 1);
