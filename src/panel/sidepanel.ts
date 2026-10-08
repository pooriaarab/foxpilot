// Side panel: loads the models, runs the agent on the current tab, and shows
// every decision as it happens.
import { env } from "@huggingface/transformers";
import { Agent, type AgentView, type Step } from "../agent/agent";
import { TabBrowser } from "../agent/browser";
import { clear, findAnswer, lastNote, lastRows, lastScores } from "../agent/answer";
import { LlmWriter, SpanWriter, type FieldWriter } from "../agent/fieldtext";
import { verify, type Verdict } from "../agent/verify";
import { onSite, siteIn, withoutSite } from "../agent/site";
import { Gliner2 } from "../model/gliner2";
import { TabGroupStatus } from "./tabgroup";

export const GLINER_MODEL = "onnx-community/gliner2-multi-v1-agent-ONNX";

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

async function attachOrOpenStart(tabId: number): Promise<TabBrowser> {
  const tab = await chrome.tabs.get(tabId);
  // Any other attach error propagates to the panel and the tab stays as it is.
  if (!RESTRICTED_URL.test(tab.url ?? "")) return TabBrowser.attach(tabId);
  $("clock-sub").textContent = "This page can't be driven; opening google.com…";
  await navigateAndWait(tabId, START_PAGE);
  const browser = await TabBrowser.attach(tabId);
  await browser.waitForLoad();
  return browser;
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

async function loadGliner() {
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
    setModel("gliner", "ok", `Ready on WebGPU · loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    setModel("gliner", "bad", `Failed to load: ${error instanceof Error ? error.message : error}`);
  }
  refreshRun();
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
  // For tests and debugging from the panel's console.
  (window as unknown as { __zipline: AgentView }).__zipline = view;
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

async function run() {
  if (running) {
    running.stop();
    return;
  }
  const goal = goalBox.value.trim();
  if (!gliner || !goal) return;
  const tabId = await targetTab();
  if (tabId === undefined) return;
  $("steps").replaceChildren();
  $("result").hidden = true;
  document.querySelectorAll(".answer, .verdict").forEach((e) => e.remove());
  // The run log reads these; a run that stops before the answer step must not show the last run's.
  Object.assign(window, { __ziplineAnswer: null, __ziplineVerdict: null });
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
    // A goal that names a site ("… on amazon.com") starts on that site; the
    // rest of the goal is what to do there.
    const site = siteIn(goal);
    let task = goal;
    let opened = false;
    browser = await attachOrOpenStart(tabId);
    if (site) {
      // The page's own location, read by a script injected into the tab.
      const here = await browser.evaluate(() => location.href).catch(() => "");
      if (!onSite(here, site)) {
        $("clock-sub").textContent = `Opening ${site.host}…`;
        await browser.navigate(site.url);
        opened = true;
      }
      task = withoutSite(goal, site) || goal;
    }
    Object.assign(window, { __ziplineSite: site ? { ...site, opened } : null });
    const setup = performance.now();
    await browser.evaluate(clear).catch(() => {});
    const useLlm = llmToggle.checked && llm && llmReady;
    running = await Agent.create(
      gliner,
      browser,
      task,
      (parts, found): FieldWriter => (useLlm ? llm! : new SpanWriter(parts, found)),
      (view) => {
        render(view);
        void status.update(view);
      },
    );
    const loopStart = performance.now();
    const page = await browser.evaluate(() => ({ url: location.href, title: document.title })).catch(() => null);
    Object.assign(window, { __ziplinePage: page });
    const view = await running.run();
    const loopEnd = performance.now();
    render(view);
    await status.update(view);
    let verdict: Verdict | null = null;
    if (view.status === "done") {
      $("clock-sub").textContent = "Checking the page against the goal…";
      verdict = view.verdict ?? await verify(gliner, await browser.observe(), view.parts, view.history).catch((error) => {
        console.error("verify failed", error);
        return null;
      });
      (window as unknown as { __ziplineVerdict: unknown }).__ziplineVerdict = verdict;
    }
    const checked = performance.now();
    if (view.status === "done" && verdict && !verdict.verified) {
      // Highlighting a "cheapest" row on a page that never reached the goal
      // (the form, a promo) looks like an answer and is not one.
      render(view);
      showVerdict(verdict);
    } else if (view.status === "done") {
      $("clock-sub").textContent = "Looking for the answer on the page…";
      let failure = "";
      const answer = await findAnswer(browser, gliner, goal).catch((error) => {
        console.error("answer search failed", error);
        failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return null;
      });
      (window as unknown as { __ziplineAnswer: unknown }).__ziplineAnswer = { answer, scores: lastScores, rows: lastRows };
      render(view);
      if (answer) showAnswer(answer.text, answer.score, answer.label);
      else showNote(failure ? `Answer search failed: ${failure}` : lastNote || "Nothing on the page stood out as the answer.");
      if (verdict) showVerdict(verdict);
    }
    // The big clock is wall time from Run, the same clock that ticked while it ran.
    // Below it, where the time went: the loop's own timer leaves out attaching,
    // reading the goal and the answer search.
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    const parts = [
      `${secs(setup - started)} attach`,
      `${secs(loopStart - setup)} reading goal`,
      `${secs(loopEnd - loopStart)} on the page`,
    ];
    if (view.status === "done") parts.push(`${secs(checked - loopEnd)} checking`, `${secs(performance.now() - checked)} finding answer`);
    $("elapsed").textContent = secs(performance.now() - started);
    $("clock-sub").textContent = parts.join(" · ");
  } catch (error) {
    const result = $<HTMLParagraphElement>("result");
    result.hidden = false;
    result.className = "result error";
    result.textContent = `Error: ${error instanceof Error ? error.message : error}`;
    await status.failed();
  } finally {
    status.finish();
    window.clearInterval(clock);
    running = null;
    await browser?.detach();
    runButton.textContent = "Run";
    runButton.classList.remove("stop");
    refreshRun();
  }
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
  const view = (window as unknown as { __zipline?: AgentView }).__zipline;
  const answer = (window as unknown as { __ziplineAnswer?: unknown }).__ziplineAnswer;
  const site = (window as unknown as { __ziplineSite?: { host: string; opened: boolean } | null }).__ziplineSite;
  const start = (window as unknown as { __ziplinePage?: { url: string; title: string } | null }).__ziplinePage;
  if (!view) return "No run yet.";
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
    `Verdict: ${JSON.stringify((window as unknown as { __ziplineVerdict?: unknown }).__ziplineVerdict ?? null)}`,
    `Answer step: ${JSON.stringify(answer ?? null).slice(0, 1500)}`,
  ];
  return lines.join("\n");
}

$("copy-log").addEventListener("click", async () => {
  await navigator.clipboard.writeText(runLog());
  $("copy-log").textContent = "Copied ✓";
  setTimeout(() => ($("copy-log").textContent = "Copy run log"), 1500);
});

goalBox.addEventListener("input", refreshRun);
runButton.addEventListener("click", () => void run());
llmToggle.addEventListener("change", () => void setLlm(llmToggle.checked));

(async () => {
  const { llm: on } = await chrome.storage.local.get("llm");
  llmToggle.checked = Boolean(on);
  await loadGliner();
  if (llmToggle.checked) await setLlm(true);
})();
