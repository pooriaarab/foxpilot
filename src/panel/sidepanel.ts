// Side panel: loads the models, runs the agent on the current tab, and shows
// every decision as it happens.
import { env } from "@huggingface/transformers";
import { Agent, type AgentView, type Step } from "../agent/agent";
import { TabBrowser } from "../agent/browser";
import { CLEAR, findAnswer, lastNote, lastRows, lastScores } from "../agent/answer";
import { LlmWriter, SpanWriter, type FieldWriter } from "../agent/fieldtext";
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

/** Where a run starts when the tab is a page Chrome won't let extensions drive (New Tab, settings…). */
const START_PAGE = "https://www.google.com/";

async function attachOrOpenStart(tabId: number): Promise<TabBrowser> {
  try {
    return await TabBrowser.attach(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/chrome:\/\/|chrome-extension:\/\/|Cannot access|Cannot attach|edge:\/\//i.test(message)) throw error;
    $("clock-sub").textContent = "This page can't be driven; opening google.com…";
    await navigateAndWait(tabId, START_PAGE);
    const browser = await TabBrowser.attach(tabId);
    await browser.waitForLoad();
    return browser;
  }
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
  document.querySelector(".answer")?.remove();
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
    browser = await attachOrOpenStart(tabId);
    const setup = performance.now();
    await browser.evaluate(CLEAR).catch(() => {});
    const useLlm = llmToggle.checked && llm && llmReady;
    running = await Agent.create(
      gliner,
      browser,
      goal,
      (parts, found): FieldWriter => (useLlm ? llm! : new SpanWriter(parts, found)),
      (view) => {
        render(view);
        void status.update(view);
      },
    );
    const loopStart = performance.now();
    const view = await running.run();
    const loopEnd = performance.now();
    render(view);
    await status.update(view);
    if (view.status === "done") {
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
    if (view.status === "done") parts.push(`${secs(performance.now() - loopEnd)} finding answer`);
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
  if (!view) return "No run yet.";
  const lines = [
    `Zipline run · ${new Date().toISOString()}`,
    `Goal: ${view.goal}`,
    `Requirements: ${view.parts.map((p) => `"${p.text}"${p.values.length ? ` [${p.values.join(", ")}]` : ""}`).join(" · ")}`,
    `Status: ${view.status}${view.message ? ` (${view.message})` : ""} · ${(view.elapsedMs / 1000).toFixed(1)} s`,
    "",
    "Steps:",
    ...view.history.map((h) =>
      `${h.step}. ${h.operation} ${h.target ?? h.action}${h.text != null ? ` ← "${h.text}"` : ""}${h.requirement ? ` for "${h.requirement}"` : ""} · ${Math.round(h.confidence * 100)}% · ${h.pageChanged === false ? "page unchanged" : "page changed"}`,
    ),
    "",
    "Decisions (top answers per requirement):",
    ...(view.decisions ?? []).map((d, i) =>
      `${i + 1}. ${d.operation} ${d.target ?? ""} · served: ${d.served.join(" | ") || "-"}\n${Object.entries(d.rawAnswers).map(([req, a]) => `   "${req}" → ${Object.entries(a).slice(0, 3).map(([l, p]) => `${l} ${p.toFixed(2)}`).join(", ")}`).join("\n")}`,
    ),
    "",
    `Text writer calls: ${JSON.stringify(view.textCalls)}`,
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
