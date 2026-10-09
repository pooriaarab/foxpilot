// Content script. It runs on every page at document_idle, finds consent and nag
// dialogs, and refuses them one step at a time: it switches off optional
// toggles, opens the next layer, scrolls, and presses "Reject" or "Save", until
// the dialog is gone. It never presses an accept-all control. The background
// runs GLiNER2 (packages/core/src/model/host.ts) and keeps the log.
import { acceptsAll, required } from "@foxpilot/core/dialogs";
import { remoteScorer } from "@foxpilot/core/model/host";
import { strike } from "@foxpilot/core/page/actuate";
import { settle } from "@foxpilot/core/page/settle";
import { snapshot } from "@foxpilot/core/page/snapshot.js";
import type { Action } from "@foxpilot/core/page/types";
import { dialogs, leaves, plan, type Plan, type Step } from "./plan";
import type { Report } from "./store";

/** The snapshot's own node map (snapshot.js). It lives in this script's view of window, not the page's. */
type Kit = { ids: WeakMap<Element, number>; nodes: Map<number, Element> };
const kit = () => (window as unknown as { __glinerFast?: Kit }).__glinerFast;

/** At most this many steps on one page, and this long on one dialog after its first step. */
const STEP_CAP = 60;
const DIALOG_MS = 60_000;

const model = remoteScorer();
const host = location.hostname;
/** Controls pressed in a dialog, by snapshot node: a layer is entered once. */
const pressed = new Set<number>();
/** When each dialog got its first step. */
const begun = new WeakMap<Element, number>();
let steps = 0;
let previous = "";
/** Why a step failed. Then nothing more is pressed on this page. */
let stopped = "";
let on = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;

const send = (report: Report) => chrome.runtime.sendMessage(report).catch(() => {});

async function scan() {
  if (running) return void (again = true);
  running = true;
  try {
    if (!on || stopped) return;
    const found = dialogs();
    if (!found.length) return;
    const actions = (snapshot()?.actions ?? []) as Action[];
    const nodeOf = (a: Action) => (a.node == null ? undefined : kit()?.nodes.get(a.node));
    // The last dialog in the page with a plan is on top. It takes the next step.
    for (const { element, stance } of found.reverse()) {
      const made = await plan(model, element, stance, actions, nodeOf, pressed);
      if (made) return await act(element, made, made.steps[0]!);
    }
  } catch (error) {
    // The model host can disconnect (the event page unloaded). The next change scans again.
    console.debug("consent-shield: no step", error);
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}

/** Takes one step and logs it. The next scan plans the step after it. A failed step stops all work on the page. */
async function act(element: Element, made: Plan, step: Step) {
  if (!on) return;
  const failed = await attempt(element, step);
  if (failed) stopped = failed;
  else if (step.node != null) pressed.add(step.node);
  await send({ type: "step", url: location.href, entry: { ...step, dialog: made.dialog, title: made.title, ...(failed ? { failed } : {}) } });
  if (!failed) schedule();
}

/** A checkbox, a switch, or a label that holds a checkbox. */
function isOn(e: Element): boolean {
  const box = e.tagName === "INPUT" ? e : e.hasAttribute("aria-checked") ? null : e.querySelector('input[type="checkbox"]');
  return box ? (box as HTMLInputElement).checked : e.getAttribute("aria-checked") === "true";
}

/** Labels that store the choices as they stand ("Confirm my choices"), not ones that refuse. */
const SAVES = /\b(?:save|confirm|submit|apply)\b/i;

/** The optional switches in the dialog that are still on, by name. Saving now would give consent. */
function stillOn(element: Element): string[] {
  const named = (e: Element) => [e.getAttribute("aria-label"), ...(e.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => id && document.getElementById(id)?.textContent),
    ...[...((e as HTMLInputElement).labels ?? [])].map((l) => l.textContent)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return [...element.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"]')]
    .filter((e) => isOn(e) && !e.matches(":disabled") && e.getAttribute("aria-disabled") !== "true")
    .map(named).filter((name) => !required(name));
}

/** Does one step. Returns why it failed, or "" when it worked. */
async function attempt(element: Element, step: Step): Promise<string> {
  if (++steps > STEP_CAP) return "step limit";
  const since = begun.get(element) ?? Date.now();
  begun.set(element, since);
  if (Date.now() - since > DIALOG_MS) return "time limit";
  if (step.kind === "scroll") return scrollDown(element) ? "" : "the dialog does not scroll";
  // The same toggle again: the page switched it back on. Do not fight the page.
  const key = `${step.kind}:${step.node}`;
  if (key === previous) return `"${step.label}" did not change`;
  previous = key;
  const target = step.node == null ? undefined : kit()?.nodes.get(step.node);
  if (!target?.isConnected || !element.contains(target)) return `"${step.label}" is not in the dialog`;
  // The hard guard. plan() never offers these; here the label on screen is checked again.
  const name = `${step.label} ${target.getAttribute("aria-label") ?? ""} ${target.textContent ?? ""}`;
  if (step.kind === "toggle" ? !isOn(target) || required(name) : acceptsAll(name)) return `refused to press "${step.label}"`;
  if (leaves(target)) return `refused to follow the link "${step.label}"`;
  if (step.kind === "press" && SAVES.test(step.label) && stillOn(element).length) return `refused to save with "${stillOn(element)[0]}" on`;
  // Bring the control to the middle, clear of a sticky button bar at the dialog's edge.
  target.scrollIntoView({ block: "center" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const action: Action = { id: "", kind: "click", label: step.label, node: step.node };
  if (!(await strike(action, null))) return `could not press "${step.label}"`;
  if (step.kind !== "toggle") {
    await settle(action);
    return "";
  }
  // A switch flips in place. settle() would wait for its dialog to close.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return isOn(target) ? `"${step.label}" did not switch off` : "";
}

const scrolls = (e: Element) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1;

/** Scrolls the dialog's scroll box, or the page, most of a screen down. Returns false when nothing moved. */
function scrollDown(element: Element): boolean {
  const ancestors: Element[] = [];
  for (let e = element.parentElement; e; e = e.parentElement) ancestors.push(e);
  const box = [element, ...element.querySelectorAll("*"), ...ancestors].find(scrolls) ?? document.scrollingElement;
  if (!box) return false;
  const top = box.scrollTop;
  box.scrollTop += Math.max(100, Math.min(box.clientHeight, innerHeight) * 0.8);
  return box.scrollTop !== top;
}

// Late dialogs (a prompt after 6 s, a second layer) arrive as mutations. Scan at most every 400 ms.
const schedule = () => (timer ??= setTimeout(() => ((timer = undefined), void scan()), 400));
const observer = new MutationObserver(schedule);

function remember(event: Event) {
  schedule();
  const ids = kit()?.ids;
  for (let e = event.target as Element | null; e && ids; e = e.parentElement) {
    const node = ids.get(e);
    if (node != null) return void pressed.add(node);
  }
}

function start() {
  on = true;
  stopped = previous = "";
  void send({ type: "start", url: location.href });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-checked", "aria-expanded", "hidden", "open", "class", "style"] });
  document.addEventListener("click", remember, true);
  // A checkbox's checked state and a scroll change no attribute, so no mutation reports them.
  document.addEventListener("change", schedule, true);
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  schedule();
}

function stop() {
  on = false;
  observer.disconnect();
  document.removeEventListener("click", remember, true);
  document.removeEventListener("change", schedule, true);
  document.removeEventListener("scroll", schedule, true);
  clearTimeout(timer);
  timer = undefined;
  void send({ type: "off", url: location.href });
}

// The per-site off switch (popup.ts). A site that is off is never scanned and never touched.
const isOff = (off: unknown) => Array.isArray(off) && off.includes(host);
void chrome.storage.local.get("off").then(({ off }) => (isOff(off) ? stop() : start()));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.off) return;
  const [was, now] = [isOff(changes.off.oldValue), isOff(changes.off.newValue)];
  if (now && !was) stop();
  if (was && !now) start();
});
