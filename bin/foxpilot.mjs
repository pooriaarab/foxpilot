#!/usr/bin/env node
// foxpilot CLI: runs goals in Firefox with the built extension (pnpm build).
//   foxpilot run --url <u> --goal <g> [--llm] [--json] [--record] [--headless]
//   foxpilot run --file tasks.jsonl [--llm] [--json] [--record] [--headless]
// A file holds one {"url", "goal"} per line; all of them run in one Firefox
// session, so the model loads once. --json prints one RunResult per line.
// --record adds modelCalls to each RunResult: every GLiNER2 call and the
// decision it fed, as training data.
// Exit code 0 only when every goal is verified on its page.
//   foxpilot mcp [--headless]
// Serves run_task, open_url, snapshot, and close as an MCP server on stdio.
//   foxpilot eval --zoo <zoo-sites checkout> [...]
// Runs the zoo-sites eval (scripts/zoo/cli.mjs) and writes docs/benchmarks/.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { format, launch, preflight } from "../scripts/lib/firefox.mjs";

if (process.argv[2] === "eval") {
  process.argv.splice(2, 1);
  await import("../scripts/zoo/cli.mjs");
  process.exit(0);
}

const USAGE = `Usage: foxpilot run (--url <url> --goal <goal> | --file <tasks.jsonl>) [--llm] [--json] [--record] [--headless]
       foxpilot mcp [--headless]
       foxpilot eval --zoo <zoo-sites checkout> [--tasks a,b] [--repeat N] [--limit N] [--extractor]`;
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" }, goal: { type: "string" }, file: { type: "string" },
      llm: { type: "boolean" }, json: { type: "boolean" }, record: { type: "boolean" }, headless: { type: "boolean" },
    },
  });
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
const { positionals: [command], values: options } = parsed;
if (command === "mcp") {
  // Logs go to stderr: stdout is the protocol.
  const { serve } = await import("../scripts/lib/mcp.mjs");
  await serve({ headless: options.headless });
} else {
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
      const result = await session.run(goal, { tabId, llm: Boolean(options.llm), record: Boolean(options.record) });
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
}
