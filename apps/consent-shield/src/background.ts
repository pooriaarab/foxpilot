// Background event page. It serves GLiNER2 to the content scripts, keeps each
// tab's log of steps, and shows the count refused on the toolbar button.
import { serveModel } from "@foxpilot/core/model/host";
import { loadModel, type AppModel } from "@foxpilot/core/model/load";
import { describe } from "./plan";
import type { Report, TabLog } from "./store";
import { tabKey } from "./store";

/** app.config.mjs `model`, set by scripts/build.mjs from packages/core/src/model/models.ts. */
declare const __MODEL__: AppModel;

// At the top level, so a content script's connect wakes this page (host.ts).
serveModel(() => loadModel(__MODEL__));

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
  // A new page, or a site switched off or on, starts a new log. The step limit
  // in content.ts bounds the log of one page.
  const tab: TabLog = report.type === "step" && stored?.url === report.url ? stored : { url: report.url, off: report.type === "off", stopped: null, log: [] };
  if (report.type === "step") {
    tab.log.push({ ...report.entry, at: Date.now() });
    tab.stopped = report.entry.failed ?? tab.stopped;
  }
  await chrome.storage.session.set({ [key]: tab });
  const done = tab.log.filter((e) => !e.failed);
  const refused = done.filter((e) => e.kind === "toggle" || e.kind === "press").length;
  await chrome.action.setBadgeText({ tabId, text: tab.off ? "off" : tab.stopped ? "!" : refused ? String(refused) : "" });
  await chrome.action.setTitle({
    tabId,
    title: tab.off ? "Consent Shield is off on this site"
      : tab.stopped ? `Consent Shield stopped: ${tab.stopped}`
      : done.length ? `Consent Shield: ${describe(done)}` : "Consent Shield",
  });
}

chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(tabKey(tabId)));
