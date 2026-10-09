// Side panel: loads the models, runs the agent on the current tab, and shows
// every decision as it happens. window.foxpilot exposes the same run to scripts.
import { env } from "@huggingface/transformers";
import { Agent, type AgentView, type Refusal, type Status, type Step, type Timing } from "../agent/agent";
import { nameInjected, TabBrowser, type Calls } from "../agent/browser";
import { clear, findAnswer, lastNote, lastRows, lastScores, type Answer } from "../agent/answer";
import { LlmWriter, SpanWriter, type FieldWriter } from "../agent/fieldtext";
import { Reporter } from "../agent/report";
import { verify, type Check, type Verdict } from "../agent/verify";
import { onSite, siteIn, withoutSite } from "../agent/site";
import { Gliner2, type ModelCall } from "@foxpilot/core/model/gliner2";
import { TabGroupStatus } from "./tabgroup";

export const GLINER_MODEL = "pooria/gliner2-multi-v1-agent-batch-ONNX";

// MV3 forbids remote code and blob: imports, so ONNX Runtime loads from ort/.
env.useWasmCache = false;
env.backends.onnx.wasm!.wasmPaths = {
  mjs: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.mjs"),
  wasm: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.wasm"),
};

const EXAMPLES = [
  {
    label: "✈ Flights NYC → SF",
    url: "https://www.google.com/travel/flights?hl=en",
    goal: "Find a one-way ticket from New York to San Francisco on October 9, 2026.",
  },
  {
    label: "🗺 Directions in Berlin",
    url: "https://www.google.com/maps?hl=en",
    goal: "Get directions from Berlin Hauptbahnhof to Brandenburg Gate.",
  },
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const goalBox = $<HTMLTextAreaElement>("goal");
const runButton = $<HTMLButtonElement>("run");
const llmToggle = $<HTMLInputElement>("llm-toggle");

let gliner: Gliner2 | null = null;
let llm: LlmWriter | null = null;
let llmReady = false;
let running: Agent | null = null;
let clock: number | undefined;

function setModel(prefix: "gliner" | "llm", state: "idle" | "loading" | "ok" | "bad", text: string, progress?: number) {
  $(`${prefix}-dot`).className = `dot ${state === "ok" ? "ok" : state === "loading" ? "warn" : state === "bad" ? "bad" : ""}`;
  $(`${prefix}-status`).textContent = text;
  const bar = $(`${prefix}-progress`);
  bar.hidden = state !== "loading";
  if (progress !== undefined) (bar.firstElementChild as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
}

/** Where a run starts when the tab is a page Firefox never lets extensions drive (New Tab, about:…). */
const START_PAGE = "https://www.google.com/";

/**
 * Pages no extension can script. See MDN, "Content scripts", "Restricted domains":
 * https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Content_scripts
 * about: pages (not reader view, which gets an error), view-source:, moz-extension:,
 * and the domains in Firefox 157's extensions.webextensions.restrictedDomains pref.
 * The URL decides this, never the text of an error.
 */
const RESTRICTED_URL =
  /^(about:(?!reader)|view-source:|moz-extension:|https:\/\/(accounts-static\.cdn\.mozilla\.net|accounts\.firefox\.com|addons\.cdn\.mozilla\.net|addons\.mozilla\.org|api\.accounts\.firefox\.com|content\.cdn\.mozilla\.net|discovery\.addons\.mozilla\.org|oauth\.accounts\.firefox\.com|profile\.accounts\.firefox\.com|support\.mozilla\.org|sync\.services\.mozilla\.com)(\/|$))/i;

function pageInfo() {
  return { url: location.href, title: document.title };
}

nameInjected({ pageInfo });

async function attachOrOpenStart(tabId: number): Promise<TabBrowser> {
  const tab = await chrome.tabs.get(tabId);
  // Any other attach error propagates to the panel and the tab stays as it is.
  if (!RESTRICTED_URL.test(tab.url ?? "")) return TabBrowser.attach(tabId);
  $("clock-sub").textContent = "This page can't be driven; opening google.com…";
  await navigateAndWait(tabId, START_PAGE);
  return TabBrowser.attach(tabId);
}

function navigateAndWait(tabId: number, url: string): Promise<void> {
  return new Promise((resolve) => {
    const done = (id: number, change: { status?: string }) => {
      if (id !== tabId || change.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(done);
    void chrome.tabs.update(tabId, { url });
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    }, 15_000);
  });
}

/** The tab to drive: ?tab=<id> when the panel is opened as a page (tests, recordings), else the active tab. */
async function targetTab(): Promise<number | undefined> {
  const param = Number(new URLSearchParams(location.search).get("tab"));
  if (param) return param;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

function refreshRun() {
  runButton.disabled = !running && (!gliner || (llmToggle.checked && !llmReady) || !goalBox.value.trim());
}

async function loadGliner(): Promise<number> {
  setModel("gliner", "loading", "Downloading 614 MB once, then cached…", 0);
  try {
    const started = performance.now();
    gliner = await Gliner2.load(GLINER_MODEL, {
      device: "webgpu",
      dtype: "fp16",
      progress_callback: (info) => {
        const i = info as { status?: string; progress?: number };
        if (i.status === "progress_total" && typeof i.progress === "number") {
          setModel("gliner", "loading", `Downloading… ${Math.round(i.progress)}%`, i.progress / 100);
        }
      },
    });
    // Compile the WebGPU shaders now rather than on the first step.
    await gliner.classify("warm up", "warmup", { a: undefined, b: undefined });
    const ms = Math.round(performance.now() - started);
    setModel("gliner", "ok", `Ready on WebGPU · loaded in ${(ms / 1000).toFixed(1)} s`);
    return ms;
  } catch (error) {
    setModel("gliner", "bad", `Failed to load: ${error instanceof Error ? error.message : error}`);
    throw error;
  } finally {
    refreshRun();
  }
}

async function setLlm(on: boolean) {
  await chrome.storage.local.set({ llm: on });
  if (!on) {
    setModel("llm", "idle", "Off: types the values GLiNER finds in your goal");
    refreshRun();
    return;
  }
  llm ??= new LlmWriter((p) => setModel("llm", "loading", `Downloading Qwen3-0.6B… ${Math.round(p * 100)}%`, p));
  if (llmReady) {
    setModel("llm", "ok", "On: Qwen3-0.6B writes field values on WebGPU");
    refreshRun();
    return;
  }
  setModel("llm", "loading", "Downloading Qwen3-0.6B (about 0.5 GB, once)…", 0);
  refreshRun();
  try {
    await llm.load();
    llmReady = true;
    setModel("llm", "ok", "On: Qwen3-0.6B writes field values on WebGPU");
  } catch (error) {
    setModel("llm", "bad", `Failed to load: ${error instanceof Error ? error.message : error}`);
  }
  refreshRun();
}

function stepItem(step: Step): HTMLLIElement {
  const li = document.createElement("li");
  const n = Object.assign(document.createElement("span"), { className: "n", textContent: String(step.step) });
  const op = Object.assign(document.createElement("span"), { className: `op ${step.operation}`, textContent: step.operation.replace("_", " ") });
  const ms = Object.assign(document.createElement("span"), {
    className: "ms",
    textContent: `${(step.elapsedMs / 1000).toFixed(1)} s · ${step.latencyMs} ms${step.textMs ? ` + ${step.textMs} ms` : ""}`,
  });
  const what = Object.assign(document.createElement("span"), { className: "what" });
  what.append(step.target ?? step.action);
  if (step.text != null) {
    what.append(" ← ");
    what.append(Object.assign(document.createElement("span"), { className: "typed", textContent: `"${step.text}"` }));
  }
  const why = Object.assign(document.createElement("span"), {
    className: "why",
    textContent: `${step.requirement ? `for "${step.requirement}" · ` : ""}${Math.round(step.confidence * 100)}%${step.textWriter ? ` · text by ${step.textWriter}` : ""}`,
  });
  what.append(why);
  li.append(n, op, ms, what);
  return li;
}

function render(view: AgentView) {
  const list = $<HTMLOListElement>("steps");
  // Rows are created once (so each animates in once) and then only refreshed.
  list.querySelector(".thinking")?.remove();
  const rows = list.querySelectorAll<HTMLLIElement>("li[data-step]");
  if (rows.length > view.history.length) list.replaceChildren();
  view.history.forEach((step, i) => {
    const existing = list.querySelector<HTMLLIElement>(`li[data-step="${step.step}"]`);
    const fresh = stepItem(step);
    fresh.dataset.step = String(step.step);
    if (!existing) list.append(fresh);
    else existing.querySelector(".ms")!.textContent = fresh.querySelector(".ms")!.textContent;
    void i;
  });
  if (view.status === "predicted" && view.decision) {
    const li = Object.assign(document.createElement("li"), { className: "thinking" });
    li.textContent = `→ ${view.decision.operation.replace("_", " ")} ${view.decision.target ?? ""}`;
    list.append(li);
  }
  const log = list.parentElement!;
  log.scrollTop = log.scrollHeight;
  $("clock-sub").textContent = `${view.history.length} actions · ${view.modelMs} ms in GLiNER2`;
  const result = $<HTMLParagraphElement>("result");
  const final = ["done", "blocked", "stopped", "error"].includes(view.status);
  result.hidden = !final;
  $("copy-log").hidden = !final;
  if (final) {
    result.className = `result ${view.status}`;
    result.textContent =
      view.status === "done"
        ? `Done: ${view.history.length} actions in ${(view.elapsedMs / 1000).toFixed(1)} s on the page. Check the page to confirm the result.`
        : view.status === "stopped"
          ? "Stopped."
          : `${view.status === "blocked" ? "Blocked" : "Error"}: ${view.message ?? "no action left to take"}`;
    log.scrollTop = log.scrollHeight;
  }
}

function showAnswer(text: string, score: number, label?: string) {
  const box = document.createElement("div");
  box.className = "answer";
  const title = Object.assign(document.createElement("strong"), { textContent: label ? `✦ ${label}` : `✦ Found on the page · ${Math.round(score * 100)}%` });
  const body = Object.assign(document.createElement("span"), { textContent: text.length > 220 ? `${text.slice(0, 220)}…` : text });
  box.append(title, body);
  $("result").after(box);
  const log = $("steps").parentElement!;
  log.scrollTop = log.scrollHeight;
}

/** The goal, part by part, checked against the finished page. */
function showVerdict(verdict: Verdict) {
  const box = document.createElement("div");
  box.className = `verdict ${verdict.verified ? "ok" : "bad"}`;
  box.append(Object.assign(document.createElement("strong"), {
    textContent: verdict.verified ? "✓ Verified on the page" : "⚠ Not verified: check the page",
  }));
  const list = document.createElement("ul");
  for (const check of verdict.checks) {
    const item = document.createElement("li");
    item.className = check.ok ? "ok" : "bad";
    item.append(
      Object.assign(document.createElement("span"), { textContent: `${check.ok ? "✓" : "✗"} ${check.part}` }),
      Object.assign(document.createElement("em"), { textContent: check.evidence }),
    );
    list.append(item);
  }
  if (verdict.problem) list.append(Object.assign(document.createElement("li"), { className: "bad", textContent: `✗ ${verdict.problem}` }));
  box.append(list);
  $("result").after(box);
}

function showNote(text: string) {
  const box = document.createElement("div");
  box.className = "answer note";
  box.append(Object.assign(document.createElement("span"), { textContent: text }));
  $("result").after(box);
}

/** One action of a finished run: what it did, ms since the action before it, and where that time went. */
export type RunStep = { step: number; operation: string; action: string; text: string | null; ms: number; timing?: Timing };

export type RunOptions = { goal: string; tabId: number; llm?: boolean;
  /** Save every GLiNER2 call in `modelCalls`. Off by default. */
  record?: boolean;
};

/** What `window.foxpilot.run` resolves to. A failed run is a result with status "error", never a rejection. */
export type RunResult = {
  /** Runs in this panel count from 1, so a caller can find its own result with `last()`. 0 when refused as busy. */
  id: number;
  goal: string;
  /** The tab's address when the run ended. */
  url: string;
  status: Status;
  message?: string;
  verified: boolean;
  answer: Answer | null;
  checks: Check[];
  steps: RunStep[];
  /** `top`: each part's two best controls and scores, so a WAIT shows what fell short of the floor. */
  decisions: { operation: string; target: string | null; confidence: number; top: Record<string, string[]>; ms?: number; calls?: number }[];
  refusals: Refusal[];
  textCalls: AgentView["textCalls"];
  /** Run to answer, in ms. */
  totalMs: number;
  /** The model load this run waited for; 0 when an earlier run in this panel paid for it. */
  modelLoadMs: number;
  evaluateCalls: Record<string, Calls>;
  /** Set when the run asked for `record`: every GLiNER2 call and the decision it fed. */
  modelCalls?: ModelCall[];
};

/** The controls the agent sees on a tab, without geometry and guards. */
export type Controls = {
  url: string;
  title: string;
  controls: { id: string; kind: string; label: string; section?: string; value?: string }[];
};

declare global {
  interface Window {
    /** The run API for scripts (scripts/lib/firefox.mjs). The Run button uses it too. */
    foxpilot: { run(options: RunOptions): Promise<RunResult>; ready(): Promise<{ modelLoadMs: number }>; last(): RunResult | null; snapshot(tabId: number): Promise<Controls> };
  }
}

let busy = false;
let runs = 0;
let lastResult: RunResult | null = null;
let loadPaid = false;
/** The last run, for the copy-log button. */
let logged: {
  agent: Agent;
  site: { host: string; opened: boolean } | null;
  start: { url: string; title: string } | null;
  verdict: Verdict | null;
  answer: { answer: Answer | null; scores: typeof lastScores; rows: typeof lastRows } | null;
} | null = null;

/** The finished run as data: the same verdict, answer and steps the panel shows. */
function outcome(view: AgentView, verdict: Verdict | null, answer: Answer | null): Partial<RunResult> {
  return {
    status: view.status,
    message: view.message,
    verified: view.status === "done" && verdict?.verified === true,
    answer,
    checks: [...(verdict?.checks ?? []), ...(verdict?.problem ? [{ part: verdict.problem, ok: false, evidence: "" }] : [])],
    steps: view.history.map((h, i) => ({
      step: h.step, operation: h.operation, action: h.target ?? h.action, text: h.text ?? null,
      ms: h.elapsedMs - (view.history[i - 1]?.elapsedMs ?? 0), timing: h.timing,
    })),
    decisions: (view.decisions ?? []).map((d) => ({
      operation: d.operation, target: d.target, confidence: d.confidence, ms: d.ms, calls: d.calls,
      top: Object.fromEntries(Object.entries(d.rawAnswers).map(([part, p]) => [part, Object.entries(p).slice(0, 2).map(([l, v]) => `${l} ${v.toFixed(2)}`)])),
    })),
    refusals: view.refusals,
    textCalls: view.textCalls,
  };
}

async function run({ goal, tabId, llm: useLlm = false, record = false }: RunOptions): Promise<RunResult> {
  const result: RunResult = {
    id: 0, goal: goal.trim(), url: "", status: "error", verified: false, answer: null, checks: [], steps: [],
    decisions: [], refusals: [], textCalls: [], totalMs: 0, modelLoadMs: 0, evaluateCalls: {},
  };
  if (busy) return { ...result, message: "A run is already in progress" };
  busy = true;
  result.id = ++runs;
  goalBox.value = result.goal;
  $("steps").replaceChildren();
  $("result").hidden = true;
  document.querySelectorAll(".answer, .verdict").forEach((e) => e.remove());
  logged = null;
  runButton.textContent = "Stop";
  runButton.classList.add("stop");
  runButton.disabled = false;
  let browser: TabBrowser | null = null;
  const status = await TabGroupStatus.start(tabId);
  void status.running();
  const started = performance.now();
  clock = window.setInterval(() => {
    $("elapsed").textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
  }, 100);
  try {
    if (!result.goal) throw new Error("Type a goal first");
    result.modelLoadMs = loadPaid ? 0 : await glinerLoad;
    loadPaid = true;
    if (useLlm || llmToggle.checked) {
      llmToggle.checked = useLlm;
      await setLlm(useLlm);
      if (useLlm && !llmReady) throw new Error("The local LLM did not load");
    }
    // A goal that names a site ("… on amazon.com") starts on that site; the
    // rest of the goal is what to do there.
    const site = siteIn(result.goal);
    let task = result.goal;
    let opened = false;
    browser = await attachOrOpenStart(tabId);
    result.evaluateCalls = browser.calls;
    if (site) {
      // The page's own location, read by a script injected into the tab.
      const here = await browser.evaluate(pageInfo).then((p) => p.url, () => "");
      if (!onSite(here, site)) {
        $("clock-sub").textContent = `Opening ${site.host}…`;
        await browser.navigate(site.url);
        opened = true;
      }
      task = withoutSite(result.goal, site) || result.goal;
    }
    const setup = performance.now();
    await browser.evaluate(clear).catch(() => {});
    const model = gliner!;
    // Field text never reaches a recorded call: password fields are not in the snapshot.
    const calls: ModelCall[] | null = record ? [] : null;
    model.recorder = calls;
    if (calls) result.modelCalls = calls;
    // Reads each page the run visits when the goal asks to report values.
    const reporter = new Reporter(model, browser, result.goal);
    reporter.seen(0);
    running = await Agent.create(
      model,
      browser,
      task,
      (parts, found, scorer): FieldWriter => (useLlm ? llm! : new SpanWriter(parts, found, scorer)),
      (view) => {
        render(view);
        void status.update(view);
        reporter.seen(view.history.length);
      },
      calls,
      (steps) => reporter.found(steps),
    );
    const loopStart = performance.now();
    const page = await browser.evaluate(pageInfo).catch(() => null);
    logged = { agent: running, site: site ? { ...site, opened } : null, start: page, verdict: null, answer: null };
    const view = await running.run();
    const loopEnd = performance.now();
    render(view);
    await status.update(view);
    let verdict: Verdict | null = null;
    let answer: Answer | null = null;
    if (view.status === "done") {
      $("clock-sub").textContent = "Checking the page against the goal…";
      verdict = view.verdict ?? await verify(model, await browser.observe(), view.parts, view.history).catch((error) => {
        console.error("verify failed", error);
        return null;
      });
      logged.verdict = verdict;
    }
    const checked = performance.now();
    if (reporter.slots.length) {
      // Done or not, verified or not: the page's state is graded, so a wrong
      // verdict must not hide the values the run did reach.
      $("clock-sub").textContent = "Reading the asked values…";
      answer = await reporter.report().catch((error) => {
        console.error("report failed", error);
        return null;
      });
      logged.answer = { answer, scores: [], rows: [] };
      render(view);
      if (answer) showAnswer(answer.text, answer.score, answer.label);
      else showNote(`Nothing on the page gave ${reporter.slots.map((s) => s.phrase).join(", ")}.`);
      if (verdict) showVerdict(verdict);
    } else if (view.status === "done" && verdict && !verdict.verified) {
      // Highlighting a "cheapest" row on a page that never reached the goal
      // (the form, a promo) looks like an answer and is not one.
      render(view);
      showVerdict(verdict);
    } else if (view.status === "done") {
      $("clock-sub").textContent = "Looking for the answer on the page…";
      let failure = "";
      answer = await findAnswer(browser, model, result.goal).catch((error) => {
        console.error("answer search failed", error);
        failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return null;
      });
      logged.answer = { answer, scores: lastScores, rows: lastRows };
      render(view);
      if (answer) showAnswer(answer.text, answer.score, answer.label);
      else showNote(failure ? `Answer search failed: ${failure}` : lastNote || "Nothing on the page stood out as the answer.");
      if (verdict) showVerdict(verdict);
    }
    Object.assign(result, outcome(view, verdict, answer));
    result.url = await browser.evaluate(pageInfo).then((p) => p.url, () => "");
    // The big clock is wall time from Run, the same clock that ticked while it ran.
    // Below it, where the time went: the loop's own timer leaves out attaching,
    // reading the goal and the answer search.
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    const parts = [
      `${secs(setup - started)} attach`,
      `${secs(loopStart - setup)} reading goal`,
      `${secs(loopEnd - loopStart)} on the page`,
    ];
    if (view.status === "done" || reporter.slots.length) parts.push(`${secs(checked - loopEnd)} checking`, `${secs(performance.now() - checked)} finding answer`);
    $("elapsed").textContent = secs(performance.now() - started);
    $("clock-sub").textContent = parts.join(" · ");
  } catch (error) {
    result.status = "error";
    result.message = error instanceof Error ? error.message : String(error);
    const box = $<HTMLParagraphElement>("result");
    box.hidden = false;
    box.className = "result error";
    box.textContent = `Error: ${result.message}`;
    await status.failed();
  } finally {
    status.finish();
    window.clearInterval(clock);
    running = null;
    // A context-menu scope covers one run only.
    await browser?.evaluate(() => { if (window.__glinerFast) window.__glinerFast.scope = null; }).catch(() => {});
    await browser?.detach();
    runButton.textContent = "Run";
    runButton.classList.remove("stop");
    refreshRun();
    result.totalMs = Math.round(performance.now() - started);
    result.evaluateCalls = Object.fromEntries(Object.entries(result.evaluateCalls).map(([name, c]) => [name, { count: c.count, ms: Math.round(c.ms) }]));
    if (gliner) gliner.recorder = null;
    lastResult = result;
    busy = false;
  }
  return result;
}

for (const example of EXAMPLES) {
  const button = Object.assign(document.createElement("button"), { type: "button", textContent: example.label });
  button.addEventListener("click", async () => {
    goalBox.value = example.goal;
    refreshRun();
    const tabId = await targetTab();
    if (tabId !== undefined) await chrome.tabs.update(tabId, { url: example.url });
  });
  $("examples").append(button);
}

/** Plain-text log of the last run: goal, requirements, every decision and step, and the answer step. */
function runLog(): string {
  if (!logged) return "No run yet.";
  const { agent: { view }, site, start, verdict, answer } = logged;
  const lines = [
    `foxpilot run · ${new Date().toISOString()}`,
    `Goal: ${view.goal}`,
    ...(site ? [`Site: ${site.host} (${site.opened ? "opened first" : "already there"})`] : []),
    ...(start ? [`Start page: ${start.title} · ${start.url.slice(0, 120)}`] : []),
    `Requirements: ${view.parts.map((p) => `"${p.text}"${p.values.length ? ` [${p.values.join(", ")}]` : ""}`).join(" · ")}`,
    `Status: ${view.status}${view.message ? ` (${view.message})` : ""} · ${(view.elapsedMs / 1000).toFixed(1)} s`,
    "",
    "Steps:",
    ...view.history.map((h) =>
      `${h.step}. ${h.operation} ${h.target ?? h.action}${h.text != null ? ` ← "${h.text}"` : ""}${h.requirement ? ` for "${h.requirement}"` : ""} · ${Math.round(h.confidence * 100)}% · ${h.pageChanged === false ? "page unchanged" : "page changed"}` +
        (h.timing ? `\n   ⏱ decide ${h.timing.decide} ms (${h.timing.calls} calls, ${h.timing.model} ms model, ≤${h.timing.labels} labels) · text ${h.textMs} ms · act ${h.timing.act} ms · observe ${h.timing.observe} ms · at ${(h.elapsedMs / 1000).toFixed(1)} s` : ""),
    ),
    "",
    "Decisions (top answers per requirement):",
    ...(view.decisions ?? []).map((d, i) =>
      `${i + 1}. ${d.operation} ${d.target ?? ""} · served: ${d.served.join(" | ") || "-"}${d.ms != null ? ` · ${d.ms} ms, ${d.calls} calls` : ""}\n${Object.entries(d.rawAnswers).map(([req, a]) => `   "${req}" → ${Object.entries(a).slice(0, 3).map(([l, p]) => `${l} ${p.toFixed(2)}`).join(", ")}`).join("\n")}`,
    ),
    "",
    `Text writer calls: ${JSON.stringify(view.textCalls)}`,
    `Refused decisions: ${JSON.stringify(view.refusals)}`,
    `Verdict: ${JSON.stringify(verdict)}`,
    `Answer step: ${JSON.stringify(answer).slice(0, 1500)}`,
  ];
  return lines.join("\n");
}

$("copy-log").addEventListener("click", async () => {
  await navigator.clipboard.writeText(runLog());
  $("copy-log").textContent = "Copied ✓";
  setTimeout(() => ($("copy-log").textContent = "Copy run log"), 1500);
});

goalBox.addEventListener("input", refreshRun);
runButton.addEventListener("click", async () => {
  if (running) return running.stop();
  const tabId = await targetTab();
  if (tabId !== undefined) await run({ goal: goalBox.value, tabId, llm: llmToggle.checked });
});
llmToggle.addEventListener("change", () => void setLlm(llmToggle.checked));

/** GLiNER2's load time in ms. The panel shows a failure; `ready()` and `run()` report it. */
const glinerLoad = loadGliner();
glinerLoad.catch(() => {});

async function snapshotControls(tabId: number): Promise<Controls> {
  const browser = await TabBrowser.attach(tabId);
  try {
    const page = await browser.observe();
    const controls = page.actions.map(({ id, kind, label, section, value }) => ({ id, kind, label, section, value }));
    return { url: page.url, title: page.title, controls };
  } finally {
    await browser.detach();
  }
}

window.foxpilot = { run, ready: () => glinerLoad.then((modelLoadMs) => ({ modelLoadMs })), last: () => lastResult, snapshot: snapshotControls };

(async () => {
  const { llm: on } = await chrome.storage.local.get("llm");
  llmToggle.checked = Boolean(on);
  await glinerLoad.catch(() => {});
  if (llmToggle.checked) await setLlm(true);
})();
