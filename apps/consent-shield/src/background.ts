// Background event page. It serves GLiNER2 to the content scripts, keeps each
// tab's dry-run plans, and shows the planned first click on the toolbar button.
import { serveModel } from "@foxpilot/core/model/host";
import { loadModel, type AppModel } from "@foxpilot/core/model/load";
import { says } from "./plan";
import type { Report, TabLog } from "./store";
import { tabKey } from "./store";

/** app.config.mjs `model`, set by scripts/build.mjs from packages/core/src/model/models.ts. */
declare const __MODEL__: AppModel;

// At the top level, so a content script's connect wakes this page (host.ts).
serveModel(() => loadModel(__MODEL__));

const LOG_CAP = 50;

// One report at a time: each one reads and writes the same tab entry.
let queue: Promise<void> = Promise.resolve();
chrome.runtime.onMessage.addListener((report: Report, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  queue = queue.then(() => record(tabId, report)).catch((error: unknown) => console.error("consent-shield:", error));
});

async function record(tabId: number, report: Report) {
  const key = tabKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key] as TabLog | undefined;
  // A new page starts a new log.
  const tab: TabLog = stored?.url === report.url ? stored : { url: report.url, off: false, plans: [], log: [] };
  tab.off = report.type === "off";
  tab.plans = report.type === "plans" ? report.plans : [];
  for (const plan of tab.plans) {
    const earlier = [...tab.log].reverse().find((p) => p.dialog === plan.dialog);
    if (JSON.stringify(earlier?.steps) !== JSON.stringify(plan.steps)) tab.log.push({ ...plan, at: Date.now() });
  }
  tab.log.splice(0, Math.max(0, tab.log.length - LOG_CAP));
  await chrome.storage.session.set({ [key]: tab });
  // The last dialog in the page is on top; its first step is the click the user would see.
  const first = tab.plans.at(-1)?.steps[0];
  await chrome.action.setBadgeText({ tabId, text: tab.off ? "off" : first ? String(tab.plans.length) : "" });
  await chrome.action.setTitle({
    tabId,
    title: tab.off ? "Consent Shield is off on this site" : first ? `Consent Shield (dry run) would ${says(first)}` : "Consent Shield",
  });
}

chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(tabKey(tabId)));
