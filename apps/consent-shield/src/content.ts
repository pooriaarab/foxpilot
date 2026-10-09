// Content script. It runs on every page at document_idle, finds consent and nag
// dialogs, and sends the background a dry-run plan for each. It presses nothing.
// The background runs GLiNER2 (packages/core/src/model/host.ts).
import { remoteScorer } from "@foxpilot/core/model/host";
import { snapshot } from "@foxpilot/core/page/snapshot.js";
import type { Action } from "@foxpilot/core/page/types";
import { dialogs, plan, type Plan } from "./plan";
import type { Report } from "./store";

/** The snapshot's own node map (snapshot.js). It lives in this script's view of window, not the page's. */
type Kit = { ids: WeakMap<Element, number>; nodes: Map<number, Element> };
const kit = () => (window as unknown as { __glinerFast?: Kit }).__glinerFast;

const model = remoteScorer();
const host = location.hostname;
/** Controls the user pressed in a dialog, by snapshot node: a layer is entered once. */
const pressed = new Set<number>();
let last = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;

const send = (report: Report) => chrome.runtime.sendMessage(report).catch(() => {});

async function scan() {
  if (running) return void (again = true);
  running = true;
  try {
    const found = dialogs();
    const plans: Plan[] = [];
    if (found.length) {
      const actions = (snapshot()?.actions ?? []) as Action[];
      const nodeOf = (a: Action) => (a.node == null ? undefined : kit()?.nodes.get(a.node));
      for (const { element, stance } of found) {
        const made = await plan(model, element, stance, actions, nodeOf, pressed);
        if (made) plans.push(made);
      }
    }
    const key = JSON.stringify(plans);
    if (key !== last) {
      last = key;
      await send({ type: "plans", url: location.href, plans });
    }
  } catch (error) {
    // The model host can disconnect (the event page unloaded). The next change scans again.
    console.debug("consent-shield: no plan", error);
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule();
    }
  }
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
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-checked", "aria-expanded", "hidden", "open", "class", "style"] });
  document.addEventListener("click", remember, true);
  // A checkbox's checked state and a scroll change no attribute, so no mutation reports them.
  document.addEventListener("change", schedule, true);
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  schedule();
}

function stop() {
  observer.disconnect();
  document.removeEventListener("click", remember, true);
  document.removeEventListener("change", schedule, true);
  document.removeEventListener("scroll", schedule, true);
  clearTimeout(timer);
  timer = undefined;
  last = "";
  void send({ type: "off", url: location.href });
}

// The per-site off switch (popup.ts). A site that is off is never scanned.
const isOff = (off: unknown) => Array.isArray(off) && off.includes(host);
void chrome.storage.local.get("off").then(({ off }) => (isOff(off) ? stop() : start()));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.off) return;
  const [was, now] = [isOff(changes.off.oldValue), isOff(changes.off.newValue)];
  if (now && !was) stop();
  if (was && !now) start();
});
