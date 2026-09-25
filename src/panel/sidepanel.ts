// Side panel: loads the models, runs the agent on the current tab, and shows
// every decision as it happens.
import { env } from "@huggingface/transformers";
import { Agent, type AgentView, type Step } from "../agent/agent";
import { TabBrowser } from "../agent/browser";
import { LlmWriter, SpanWriter, type FieldWriter } from "../agent/fieldtext";
import { Gliner2 } from "../model/gliner2";

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
    label: "🚶 Walking directions",
    url: "https://www.google.com/maps?hl=en",
    goal: "Get directions from Berlin Hauptbahnhof to Brandenburg Gate. Select Walking.",
  },
  {
    label: "📚 Wikipedia search",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "Search Wikipedia for the Golden Gate Bridge.",
  },
];

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
  const list = $<HTMLOListElement>("steps");
  list.replaceChildren(...view.history.map(stepItem));
  if (view.status === "predicted" && view.decision) {
    const li = Object.assign(document.createElement("li"), { className: "thinking" });
    li.textContent = `→ ${view.decision.operation.replace("_", " ")} ${view.decision.target ?? ""}`;
    list.append(li);
  }
  $("clock-sub").textContent = `${view.history.length} actions · ${view.modelMs} ms in GLiNER2`;
  const result = $<HTMLParagraphElement>("result");
  const final = ["done", "blocked", "stopped", "error"].includes(view.status);
  result.hidden = !final;
  if (final) {
    result.className = `result ${view.status}`;
    result.textContent =
      view.status === "done"
        ? `Done in ${(view.elapsedMs / 1000).toFixed(1)} s. Check the page to confirm the result.`
        : view.status === "stopped"
          ? "Stopped."
          : `${view.status === "blocked" ? "Blocked" : "Error"}: ${view.message ?? "no action left to take"}`;
  }
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
  runButton.textContent = "Stop";
  runButton.classList.add("stop");
  runButton.disabled = false;
  let browser: TabBrowser | null = null;
  const started = performance.now();
  clock = window.setInterval(() => {
    $("elapsed").textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
  }, 100);
  try {
    browser = await TabBrowser.attach(tabId);
    const useLlm = llmToggle.checked && llm && llmReady;
    running = await Agent.create(
      gliner,
      browser,
      goal,
      (parts, found): FieldWriter => (useLlm ? llm! : new SpanWriter(parts, found)),
      render,
    );
    const view = await running.run();
    render(view);
    $("elapsed").textContent = `${(view.elapsedMs / 1000).toFixed(1)} s`;
  } catch (error) {
    const result = $<HTMLParagraphElement>("result");
    result.hidden = false;
    result.className = "result error";
    result.textContent = `Error: ${error instanceof Error ? error.message : error}`;
  } finally {
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

goalBox.addEventListener("input", refreshRun);
runButton.addEventListener("click", () => void run());
llmToggle.addEventListener("change", () => void setLlm(llmToggle.checked));

(async () => {
  const { llm: on } = await chrome.storage.local.get("llm");
  llmToggle.checked = Boolean(on);
  await loadGliner();
  if (llmToggle.checked) await setLlm(true);
})();
