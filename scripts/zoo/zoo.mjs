// Loads a zoo-sites checkout (https://github.com/bgrins/zoo-sites, Apache-2.0),
// starts its pages server, lists its tasks in the form foxpilot can attempt, and
// grades a finished run with the checkout's own validators. Nothing from
// zoo-sites is copied here: every module comes from the path the caller gives.
// The checkout needs `npm install`, because its task modules import extract.mjs,
// which imports @anthropic-ai/claude-agent-sdk.
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = (root, file) => import(pathToFileURL(join(root, file)).href);

// The reasons a task is out of reach for one goal on one page, in the order
// they are checked. A skipped task stays in the report with its reason.
export const SKIP = {
  devtools: "devtools: the task reads network or console state",
  multiSite: "multi-site: the ask names more than one site",
  multiPage: "multi-page: the ask names more than one start page",
  extraction: "extraction-only: zoo-sites files the task under extraction",
  extractor: "needs extractor: the validator grades typed fields from the answer (pass --extractor)",
};

export async function openZoo(path, { seed = null } = {}) {
  const root = resolve(path);
  const [{ startPagesServer }, { basicTasks }, { webTasks }, { devtoolsTasks }, extract] = await Promise.all([
    load(root, "server.mjs"),
    load(root, "eval/tasks/basic.mjs"),
    load(root, "eval/tasks/web.mjs"),
    load(root, "eval/tasks/devtools.mjs"),
    load(root, "eval/extract.mjs"),
  ]);
  // Single-origin serving, the gate's default: every site under one port.
  const pages = await startPagesServer({ seed });
  const tasks = [
    ...basicTasks(pages.url).map((task) => ({ task, suite: "basic" })),
    ...(await webTasks(pages.url)).map((task) => ({ task, suite: "web" })),
    ...(await devtoolsTasks(pages.url)).map((task) => ({ task, suite: "devtools" })),
  ];
  let commit = null;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
  return { root, commit, pages, tasks, extract, close: () => pages.close() };
}

// Every URL the ask names on the zoo server, without the sentence punctuation
// that follows it ("/shop/voltro/," or "/portal/:").
function startUrls(ask, base) {
  const found = ask.match(/https?:\/\/[^\s)'"`]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,:;]+$/, "")))].filter((u) => u.startsWith(base));
}

// The site a URL belongs to: in single-origin serving, its path prefix.
const siteOf = (url, base) => url.slice(base.length).split("/").filter(Boolean).slice(0, 2).join("/");

// One inventory entry per task: where it starts, the goal foxpilot gets, how it
// is graded, and why it is skipped, if it is.
export function inventory(zoo, { extractor = false } = {}) {
  const base = zoo.pages.url;
  return zoo.tasks.map(({ task, suite }) => {
    const urls = startUrls(task.ask, base);
    const url = urls[0] ?? null;
    // "answer": a regex over the prose answer, free. "fields": the validator
    // reads server state plus typed fields extracted from the answer.
    const grading = task.validate ? (task.answerSchema ? "fields" : "state") : "answer";
    let skipped = null;
    if (suite === "devtools") skipped = SKIP.devtools;
    else if (new Set(urls.map((u) => siteOf(u, base))).size > 1) skipped = SKIP.multiSite;
    else if (urls.length > 1) skipped = SKIP.multiPage;
    else if (task.family === "extraction") skipped = SKIP.extraction;
    else if (grading === "fields" && !extractor) skipped = SKIP.extractor;
    else if (!url) skipped = "no start URL in the ask";
    return { id: task.id, family: task.family, suite, url, goal: url ? toGoal(task.ask, url) : null, grading, skipped, task };
  });
}

// foxpilot opens the start URL itself and takes one goal on that page, so the
// goal is the ask with its start URL replaced by "this page".
export function toGoal(ask, url) {
  return ask.split(url).join("this page").replace(/\s+/g, " ").trim();
}

// Grades one finished run in the way zoo-sites' run.mjs grades a row. A backend
// that returns its own fields (zoo-sites' scripted backend) is graded on them.
// Otherwise the fields come from zoo-sites' extractor, which is a paid model
// call; it runs only when `extractor` is set. Call it before the next task
// resets the server state.
export async function grade(zoo, entry, { answer, fields, extractor = false }) {
  const { task } = entry;
  const text = answer ?? "";
  let extraction = null;
  if (fields === undefined) {
    fields = null;
    if (task.answerSchema && extractor && !zoo.extract.isSentinel(text)) {
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !extraction; attempt++) {
        try {
          ({ fields, extraction } = await zoo.extract.extractFields({ ask: task.ask, answer: text, schema: task.answerSchema }));
        } catch (error) {
          lastError = error;
        }
      }
      if (!extraction) extraction = { error: String(lastError?.message ?? lastError) };
    }
  }
  try {
    const verdict = task.validate
      ? task.validate(text, { pages: zoo.pages }, fields)
      : { pass: task.expect.test(text.replace(/[*_~`]+/g, "")) };
    return { pass: Boolean(verdict.pass), detail: verdict.detail ?? null, fields, extraction };
  } catch (error) {
    return { pass: false, detail: `VALIDATOR ERROR: ${error?.message ?? error}`, fields, extraction };
  }
}

// Fresh server state before each attempt, with the task's own serving modes,
// as zoo-sites' run.mjs does.
export function resetFor(zoo, entry) {
  zoo.pages.state.reset();
  Object.assign(zoo.pages.state.modes, entry.task.serverModes ?? {});
}
